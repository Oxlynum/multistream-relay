import type { NextRequest } from 'next/server'
import { authenticateAgentDetailed, authenticateNode, type NodeAuth } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { triggerAutoRefill } from '@/app/api/credits/auto-refill/route'
import { teardownInstance, teardownHub, sweepStalePods } from '@/lib/pod-teardown'
import { HUB_IDLE_GRACE_MS } from '@/lib/datacenters'
import { spendableTokens, type OutputStatus, type BillingPlatformRow } from '@/lib/billing'
import { billStreamInterval } from '@/lib/billing-clock'

// Dev billing bypass (single user id) — shared by the pod + hub clocks.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isDevNoBilling(userId: string): boolean {
  const id = process.env.SLIMCAST_DEV_NO_BILLING_USER_ID ?? ''
  return !!userId && UUID_RE.test(id) && id === userId
}

// A pod that's up but not streaming this long is abandoned → destroy it.
const IDLE_GRACE_S = 5 * 60 // 5m

// Billing master switch (vps-hub-plan §7: DEACTIVATED during the VPS-hub build —
// free streaming in dev). OFF by default; the credit deduction, auto-refill, and
// credits<=0 self-destruct are all gated on it. The idle / max-session / orphan
// self-destruct safety is NOT gated (rogue-cost protection always stays on).
// Reversible: set SLIMCAST_BILLING_ACTIVE=true to re-enable.
const BILLING_ACTIVE = process.env.SLIMCAST_BILLING_ACTIVE === 'true'

// Shared by BOTH billing clocks (pod + hub Clock A): when a streaming user's spendable
// balance dips below a token, try the saved-card auto-refill before any credits kill.
// Returns the (possibly refilled) spendable total. No-op when not low or refill is off.
async function refillAndRecheck(
  supabase: ReturnType<typeof createServerClient>,
  userId: string,
  spendable: number,
): Promise<number> {
  if (spendable >= 1.0) return spendable
  const refilled = await triggerAutoRefill(userId)
  if (!refilled) return spendable
  const { data } = await supabase
    .from('profiles')
    .select('allotment_tokens, streaming_credits')
    .eq('id', userId)
    .single()
  return spendableTokens(data)
}

// VPS-hub GPU BACKEND heartbeat: just refresh relay_nodes.last_seen_at so the reaper
// can detect a mid-stream GPU death (stale heartbeat while the parent session is live)
// and re-race. Billing is off → return a large credits_seconds so the relay never
// self-stops. Operates ONLY on relay_nodes (never the per-user gpu_instances path).
async function handleGpuStatus(node: NodeAuth): Promise<Response> {
  const supabase = createServerClient()
  await supabase.from('relay_nodes').update({ last_seen_at: new Date().toISOString() }).eq('id', node.nodeId!)
  return Response.json({ ok: true, credits_seconds: 999999 })
}

// ── VPS-as-the-Hub heartbeat (Clock A) ───────────────────────────────────────
// A shared hub posts ONE heartbeat for all its tenants (authenticated by its 'vps'
// key, resolved by authenticateNode → never a single user). For each tenant it
// refreshes last_seen_at/streaming/idle_since and applies Clock A: a LOGICAL
// teardown of just that tenant on idle/max-session (detach_from_hub + drop the
// session row — NEVER destroys the shared box; Clock B/reaper does that when the
// box goes empty). Do NOT route a hub key through the per-user pod path below
// (landmine #2: that would teardown the whole box on the first tenant's idle).
async function handleVpsStatus(request: NextRequest, hubId: string): Promise<Response> {
  const body = await request.json().catch(() => ({})) as {
    streams?: Array<{ ingest_key?: string; streaming?: boolean }>
    cost?: { egress_gb_hr?: number; ingress_gb_hr?: number; projected_usd_hr?: number }
  }
  const supabase = createServerClient()
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  const hubUpdate: Record<string, unknown> = { last_seen_at: nowIso }
  if (body.cost) {
    hubUpdate.cost_usd_hr = body.cost.projected_usd_hr ?? null
    hubUpdate.egress_gb_hr = body.cost.egress_gb_hr ?? null
    hubUpdate.ingress_gb_hr = body.cost.ingress_gb_hr ?? null
  }
  await supabase.from('vps_hubs').update(hubUpdate).eq('id', hubId)

  // The hub is heartbeating → it's live. Promote any tenant still 'provisioning'
  // (attached while the hub was spawning). This self-heals a lost/partial /ready,
  // which is otherwise the ONLY promoter (review #13).
  await supabase.from('gpu_instances')
    .update({ status: 'running', phase: 'ready' })
    .eq('vps_hub_id', hubId).eq('status', 'provisioning')

  const reported = body.streams ?? []
  const { data: sessions } = await supabase
    .from('gpu_instances')
    .select('user_id, ingest_key, idle_since, max_session_at, last_seen_at')
    .eq('vps_hub_id', hubId)

  // Batch-load the billing inputs for every tenant on this hub (the VPS heartbeat is the
  // canonical billing clock for hub tenants — vps-hub-plan §2.4). One query each, grouped
  // in memory, so a 10-tenant hub stays at 2 reads/beat regardless of tenant count.
  const tenantIds = (sessions ?? []).map(s => s.user_id as string)
  const [{ data: tenantProfiles }, { data: tenantPlatforms }] = tenantIds.length
    ? await Promise.all([
        supabase.from('profiles')
          .select('id, plan, allotment_tokens, streaming_credits, has_2k_addon, output_settings')
          .in('id', tenantIds),
        supabase.from('platform_connections')
          .select('user_id, platform, orientation, enabled, twitch_hevc_eligible, twitch_use_passthrough')
          .in('user_id', tenantIds),
      ])
    : [{ data: [] }, { data: [] }]
  const profileById = new Map((tenantProfiles ?? []).map(p => [p.id as string, p]))
  const platformsByUser = new Map<string, BillingPlatformRow[]>()
  for (const row of tenantPlatforms ?? []) {
    const uid = row.user_id as string
    const arr = platformsByUser.get(uid) ?? []
    arr.push(row as unknown as BillingPlatformRow)
    platformsByUser.set(uid, arr)
  }

  for (const s of sessions ?? []) {
    const userId = s.user_id as string
    const r = reported.find(x => x.ingest_key === s.ingest_key)
    const streaming = r?.streaming ?? false
    const idleSince = streaming ? null : (s.idle_since ?? nowIso)
    const prevSeen = s.last_seen_at ? new Date(s.last_seen_at).getTime() : now

    // Plan-aware per-tenant billing (allotment-first; passthrough cheaper for subscribers).
    const bill = await billStreamInterval({
      userId,
      profile: profileById.get(userId) ?? null,
      platforms: platformsByUser.get(userId) ?? [],
      streaming,
      lastSeenAtMs: prevSeen,
      nowMs: now,
      billingActive: BILLING_ACTIVE,
      devBypass: isDevNoBilling(userId),
    })

    await supabase.from('gpu_instances')
      .update({ last_seen_at: nowIso, streaming, idle_since: idleSince, burn_rate: bill.burnRate })
      .eq('user_id', userId).eq('vps_hub_id', hubId)

    // Try auto-refill before any credits kill (mirrors the pod clock so the two don't diverge).
    let spendable = bill.spendableAfter
    if (BILLING_ACTIVE && streaming) spendable = await refillAndRecheck(supabase, userId, spendable)

    // Clock A — logical teardown of THIS tenant only (never destroys the shared box).
    const idleFor = idleSince ? (now - new Date(idleSince).getTime()) / 1000 : 0
    const maxAt = s.max_session_at ? new Date(s.max_session_at).getTime() : null
    if (maxAt && now >= maxAt) {
      await teardownInstance(userId, 'hub_clockA:session_expired')
    } else if (BILLING_ACTIVE && spendable <= 0) {
      await teardownInstance(userId, 'hub_clockA:credits_exhausted')
    } else if (!streaming && idleFor > IDLE_GRACE_S) {
      await teardownInstance(userId, 'hub_clockA:idle_timeout')
    }
  }

  // Scale-to-zero (Clock B, timely path): if this hub has been empty past the idle
  // grace, self-destruct now rather than waiting for the cron reaper (which only
  // backstops a hub that stopped heartbeating). Re-read the refcount so a tenant
  // that attached this instant isn't dropped.
  const { data: hubNow } = await supabase
    .from('vps_hubs')
    .select('session_count, empty_since')
    .eq('id', hubId)
    .maybeSingle()
  if (
    hubNow && (hubNow.session_count ?? 0) <= 0 && hubNow.empty_since &&
    (now - new Date(hubNow.empty_since).getTime()) > HUB_IDLE_GRACE_MS
  ) {
    console.log(`[agent/status] hub ${hubId} empty past grace — scale-to-zero`)
    // onlyIfEmpty: atomic drain barrier — aborts if a tenant raced in (review #4/#15).
    await teardownHub(hubId, 'scale_to_zero', { onlyIfEmpty: true })
    return Response.json({ command: 'stop', reason: 'scale_to_zero' })
  }

  // The relay learns the live stream set from /api/agent/hub-config; per-tenant
  // stops happen implicitly when a torn-down tenant drops out of that set. So the
  // status response is just an ack (+ large credits so the relay never self-stops).
  return Response.json({ ok: true, credits_seconds: 999999 })
}

// Agent posts heartbeats here every 10s with live stream status.
export async function POST(request: NextRequest) {
  // Role-aware: a 'vps' hub key heartbeats for many tenants — handle first so it
  // never falls into the per-user pod billing/self-destruct path.
  const node = await authenticateNode(request)
  if (node?.role === 'vps' && node.hubId) {
    return handleVpsStatus(request, node.hubId)
  }
  if (node?.role === 'gpu' && node.nodeId) {
    return handleGpuStatus(node)
  }

  const authed = await authenticateAgentDetailed(request)
  if (!authed) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { userId, label } = authed
  const isPodAgent = label === 'pod'

  const body = await request.json().catch(() => ({}))
  const { outputs = [], streaming = false, cost, throttle } = body as {
    outputs: OutputStatus[]
    streaming: boolean
    // Live infrastructure-cost telemetry from the pod (Phase 1). Optional: absent
    // on the first heartbeat (no bandwidth delta yet) and from dashboard/dock polls.
    cost?: { egress_gb_hr?: number; ingress_gb_hr?: number; projected_usd_hr?: number }
    // Budget-throttle state from the pod's controller. suggested_ingest_kbps is the
    // OBS source bitrate the plugin should apply (null = no throttle, run free).
    throttle?: { tier?: number; active?: boolean; suggested_ingest_kbps?: number | null }
  }
  const outSummary = outputs.map((o: OutputStatus) => `${o.name}:${o.state}(exit=${o.last_exit ?? '-'},r=${o.restarts ?? 0})`).join(' ')
  console.log(`[agent/status] label=${label} streaming=${streaming} outputs=${outputs.length} ${outSummary}`)

  const supabase = createServerClient()

  const [{ data: instance }, { data: profile }, { data: platforms }] = await Promise.all([
    supabase
      .from('gpu_instances')
      .select('id, last_seen_at, burn_rate, created_at, idle_since, session_id, max_session_at')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('profiles')
      .select('plan, allotment_tokens, streaming_credits, output_settings, has_2k_addon, landscape_bitrate_kbps, portrait_bitrate_kbps')
      .eq('id', userId)
      .single(),
    // Only needed by the pod agent for billing; skip for dashboard/dock polls.
    isPodAgent
      ? supabase
          .from('platform_connections')
          .select('platform, orientation, enabled, twitch_hevc_eligible, twitch_use_passthrough')
          .eq('user_id', userId)
      : Promise.resolve({ data: null }),
  ])

  // Spendable = rolling allotment (subscribers) + purchased balance.
  let credits = spendableTokens(profile)
  let burnRate = instance?.burn_rate ?? 0

  const now = Date.now()

  // --- Billing: only the pod agent is the billing clock ---------------------
  if (isPodAgent) {
    const devNoBilling = isDevNoBilling(userId)

    const bill = await billStreamInterval({
      userId,
      profile,
      platforms: (platforms ?? []) as unknown as BillingPlatformRow[],
      streaming,
      throttleTier: throttle?.tier ?? 0,
      lastSeenAtMs: instance?.last_seen_at ? new Date(instance.last_seen_at).getTime() : now,
      nowMs: now,
      billingActive: BILLING_ACTIVE,
      devBypass: devNoBilling,
    })
    burnRate = bill.burnRate
    const deduct = bill.deduct
    credits = bill.spendableAfter
    if (devNoBilling && deduct > 0) console.log(`[billing] dev bypass active for ${userId} — deduction of ${deduct} tkn skipped`)
    // Deduction already applied atomically (allotment-first) inside billStreamInterval
    // when billing is active; `credits` is the post-interval spendable balance.

    const idleSince = streaming
      ? null
      : (instance?.idle_since ?? new Date(now).toISOString())

    // --- Session recording ------------------------------------------------
    let sessionId = instance?.session_id ?? null
    const livePlatforms = Array.from(
      new Set(outputs.flatMap(o => o.platforms ?? []))
    )

    if (streaming && !sessionId) {
      const { data: opened } = await supabase
        .from('stream_sessions')
        .insert({
          user_id: userId,
          started_at: new Date(now).toISOString(),
          duration_seconds: 0,
          credits_deducted: 0,
          platforms: livePlatforms,
          billed_model: bill.plan,
        })
        .select('id')
        .single()
      sessionId = opened?.id ?? null
    } else if (streaming && sessionId) {
      const { data: open } = await supabase
        .from('stream_sessions')
        .select('started_at, credits_deducted, platforms')
        .eq('id', sessionId)
        .maybeSingle()
      if (open) {
        const merged = Array.from(new Set([...(open.platforms ?? []), ...livePlatforms]))
        await supabase
          .from('stream_sessions')
          .update({
            duration_seconds: Math.round((now - new Date(open.started_at).getTime()) / 1000),
            credits_deducted: parseFloat(((open.credits_deducted ?? 0) + deduct).toFixed(6)),
            platforms: merged,
          })
          .eq('id', sessionId)
      } else {
        sessionId = null
      }
    } else if (!streaming && sessionId) {
      await supabase
        .from('stream_sessions')
        .update({ ended_at: new Date(now).toISOString() })
        .eq('id', sessionId)
        .is('ended_at', null)
      sessionId = null
    }

    await supabase
      .from('gpu_instances')
      .update({
        last_seen_at: new Date(now).toISOString(),
        burn_rate: burnRate,
        outputs,
        streaming,
        idle_since: idleSince,
        session_id: sessionId,
        // Live infrastructure cost (Phase 1 telemetry). Only updated when the pod
        // reports it — leaves the last value intact on the first/empty beat.
        ...(cost
          ? {
              cost_usd_hr: cost.projected_usd_hr ?? null,
              egress_gb_hr: cost.egress_gb_hr ?? null,
              ingress_gb_hr: cost.ingress_gb_hr ?? null,
            }
          : {}),
        // Budget-throttle state — surfaced to the OBS plugin via /api/gpu/status so
        // it can lower the live encoder bitrate (cuts ingress + YouTube passthrough).
        ...(throttle
          ? {
              throttle_tier: throttle.tier ?? 0,
              suggested_ingest_kbps: throttle.suggested_ingest_kbps ?? null,
            }
          : {}),
      })
      .eq('user_id', userId)

    if (BILLING_ACTIVE && streaming) {
      credits = await refillAndRecheck(supabase, userId, credits)
    }

    // ── Connection metrics: write one inbound + one per active platform ────────
    if (instance?.id) {
      const instanceId = instance.id
      const landscapeBitrate = (profile as { landscape_bitrate_kbps?: number })?.landscape_bitrate_kbps ?? 6000
      const portraitBitrate = (profile as { portrait_bitrate_kbps?: number })?.portrait_bitrate_kbps ?? 4000

      const inboundHealth = streaming ? 100 : 0
      const metricsRows: Array<{
        instance_id: string; user_id: string; direction: string;
        platform: string | null; bitrate_kbps: number | null; health_score: number; dropped_frames: number;
      }> = [
        { instance_id: instanceId, user_id: userId, direction: 'inbound', platform: null,
          bitrate_kbps: null, health_score: inboundHealth, dropped_frames: 0 },
      ]

      for (const o of outputs) {
        const health = o.state === 'running' ? 100 : o.state === 'restarting' ? 50 : 0
        const bitrate = o.mode === 'portrait' ? portraitBitrate : landscapeBitrate
        for (const p of o.platforms ?? []) {
          metricsRows.push({ instance_id: instanceId, user_id: userId, direction: 'outbound',
            platform: p, bitrate_kbps: bitrate, health_score: health, dropped_frames: 0 })
        }
      }

      supabase.from('connection_metrics').insert(metricsRows).then(() => {})
    }

    // ── SAFETY: destroy the pod on any hard condition ───────────────────────
    const idleFor = idleSince ? (now - new Date(idleSince).getTime()) / 1000 : 0
    const maxSessionAt = instance?.max_session_at ? new Date(instance.max_session_at).getTime() : null

    let killReason = ''
    if (BILLING_ACTIVE && credits <= 0) killReason = 'credits_exhausted'
    else if (maxSessionAt && now >= maxSessionAt) killReason = 'session_expired'
    else if (!streaming && idleFor > IDLE_GRACE_S) killReason = 'idle_timeout'

    if (killReason) {
      await teardownInstance(userId, `heartbeat:${killReason}`)
      return Response.json({ command: 'stop', reason: killReason, credits, credits_seconds: Math.round(credits * 3600), burn_rate: 0 })
    }
  }

  if (isPodAgent) sweepStalePods().catch(e => console.error('[sweep] error:', e))

  const { data: cmd } = await supabase
    .from('agent_commands')
    .select('id, command')
    .eq('user_id', userId)
    .is('executed_at', null)
    .order('issued_at', { ascending: true })
    .limit(1)
    .single()

  if (cmd) {
    await supabase
      .from('agent_commands')
      .update({ executed_at: new Date().toISOString() })
      .eq('id', cmd.id)

    return Response.json({ command: cmd.command, credits, credits_seconds: Math.round(credits * 3600), burn_rate: burnRate })
  }

  return Response.json({ command: null, credits, credits_seconds: Math.round(credits * 3600), burn_rate: burnRate, outputs })
}
