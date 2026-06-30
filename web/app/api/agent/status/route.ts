import type { NextRequest } from 'next/server'
import { after } from 'next/server'
import { authenticateAgentDetailed, authenticateNode, type NodeAuth } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { triggerAutoRefill } from '@/app/api/credits/auto-refill/route'
import { teardownInstance, teardownHub, sweepExpiredLeases } from '@/lib/pod-teardown'
import { HUB_IDLE_GRACE_MS, BOX_LEASE_MS, RECONNECT_GRACE_MS, PROVISION_LEASE_MS } from '@/lib/datacenters'
import { spendableTokens, type BillingPlatformRow } from '@/lib/billing'
import { billStreamInterval } from '@/lib/billing-clock'
import { promoteGpuNodeReady } from '@/lib/gpu-ready'

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

// VPS-hub GPU BACKEND heartbeat: refresh relay_nodes.last_seen_at so the reaper can
// detect a mid-stream GPU death (stale heartbeat while the parent session is live) and
// re-race; AND record bridge telemetry. The GPU backend is single-tenant, so its whole
// net throughput IS the internal VPS↔GPU bridge leg — the relay measures it (CostMeter
// on /proc/net/dev) and reports {ingress_kbps,egress_kbps,active}. We attribute it to the
// owning session (relay_nodes → instance_id/user_id) and write a direction='bridge'
// connection_metrics row the dock plots. Billing is off → return a large credits_seconds
// so the relay never self-stops. Operates ONLY on relay_nodes (never the gpu_instances path).
async function handleGpuStatus(request: NextRequest, node: NodeAuth): Promise<Response> {
  const supabase = createServerClient()
  // Bump last_seen_at + renew the GPU-backend BOX lease, and read the owning session
  // in one round-trip. renew_deadline is what lets the universal sweeper destroy this
  // box if its heartbeat ever stops (no daily-cron dependency, any provider).
  const { data: nodeRow } = await supabase
    .from('relay_nodes')
    .update({
      last_seen_at: new Date().toISOString(),
      renew_deadline: new Date(Date.now() + BOX_LEASE_MS).toISOString(),
    })
    .eq('id', node.nodeId!)
    .select('instance_id, user_id')
    .maybeSingle()

  const body = await request.json().catch(() => ({})) as {
    ip?: string; bridge_port?: number; provider_id?: string
    bridge?: { ingress_kbps?: number; egress_kbps?: number; active?: boolean }
  }
  // Self-heal a lost /ready: the GPU carries its bridge address on every beat. If its
  // readiness POST was dropped at the edge, this node is still phase='racing' (un-bridged,
  // un-reaped, billing) — re-run the idempotent winner-CAS now to promote it racing→ready
  // so hub-config opens the bridge. A no-op once already promoted.
  if (body.ip && body.bridge_port) {
    await promoteGpuNodeReady(node.nodeId!, { ip: body.ip, bridgePort: body.bridge_port, providerId: body.provider_id })
      .catch(e => console.error('[agent/status] gpu /ready self-heal failed:', e))
  }
  if (body.bridge && nodeRow?.instance_id && nodeRow?.user_id) {
    // Return leg (GPU→VPS) = the delivered transcode → the meaningful bridge bitrate.
    const egressKbps = Math.max(0, Math.round(body.bridge.egress_kbps ?? 0))
    const active = body.bridge.active ?? false
    // Health: transcoding + return flowing = healthy; transcoding but no return bytes
    // = degraded (bridge stalled); not transcoding = idle.
    const health = active ? (egressKbps > 0 ? 100 : 50) : 0
    // AWAIT (not fire-and-forget): handleGpuStatus has no trailing awaited work, so an
    // un-awaited insert would race the Response and can be dropped on Vercel. One ~10ms
    // round-trip on a 10s heartbeat is negligible.
    await supabase.from('connection_metrics').insert({
      instance_id: nodeRow.instance_id as string,
      user_id: nodeRow.user_id as string,
      direction: 'bridge',
      platform: null,
      bitrate_kbps: egressKbps,
      health_score: health,
      dropped_frames: 0,
    })
  }
  // Heartbeat-driven universal sweep: any live box reaps stale ones within ~1 beat
  // (drops the old isPodAgent gate — a GPU backend beat now drives reaping too). Run it
  // via after() so it completes AFTER the response on Vercel Fluid Compute rather than
  // being frozen mid-scan as a bare floating promise (review #7 — this is now the PRIMARY
  // reaper, so its completion must be guaranteed, not best-effort).
  after(() => sweepExpiredLeases().catch(e => console.error('[sweep] gpu-beat error:', e)))
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
    streams?: Array<{
      ingest_key?: string
      streaming?: boolean
      // Per-platform runner states (state + platforms[]) the dock turns into status
      // dots. Empty while OBS isn't publishing. The hub is the ONLY producer of this
      // now (the all-in-one pod heartbeat that used to write gpu_instances.outputs was
      // deleted with the direct path 2026-06-29) — without persisting it the dock dots
      // stay stuck on "idle".
      outputs?: Array<{ state?: string; platforms?: string[] }>
    }>
    cost?: { egress_gb_hr?: number; ingress_gb_hr?: number; projected_usd_hr?: number }
  }
  const supabase = createServerClient()
  const now = Date.now()
  const nowIso = new Date(now).toISOString()

  // Renew the hub BOX lease on every heartbeat. This is the incident fix: a hub
  // whose relay stops heartbeating (dead agent / network partition / OOM) lapses
  // past renew_deadline within ~12 beats and the universal sweeper hard-destroys it
  // — no longer dependent on the daily cron or on a correct scale-to-zero decision.
  const hubUpdate: Record<string, unknown> = {
    last_seen_at: nowIso,
    renew_deadline: new Date(now + BOX_LEASE_MS).toISOString(),
  }
  if (body.cost) {
    hubUpdate.cost_usd_hr = body.cost.projected_usd_hr ?? null
    hubUpdate.egress_gb_hr = body.cost.egress_gb_hr ?? null
    hubUpdate.ingress_gb_hr = body.cost.ingress_gb_hr ?? null
  }
  await supabase.from('vps_hubs').update(hubUpdate).eq('id', hubId)

  // The hub is heartbeating → it's live. Promote any tenant still 'provisioning'
  // (attached while the hub was spawning). This self-heals a lost/partial /ready,
  // which is otherwise the ONLY promoter (review #13). REFRESH the tenant lease on
  // promotion: attach seeded a boot lease covering hub spawn; now that the hub is
  // serveable, give a fresh first-connect window so a slow OBS start is governed by the
  // 5-min idle grace, not reaped mid-bringup (review #2/#3/#8/#12). Streaming renewals
  // (RECONNECT_GRACE_MS) take over once the tenant actually publishes.
  await supabase.from('gpu_instances')
    .update({
      status: 'running', phase: 'ready',
      renew_deadline: new Date(now + PROVISION_LEASE_MS).toISOString(),
    })
    .eq('vps_hub_id', hubId).eq('status', 'provisioning')

  const reported = body.streams ?? []
  const { data: sessions } = await supabase
    .from('gpu_instances')
    .select('id, user_id, ingest_key, idle_since, max_session_at, last_seen_at')
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

    // Renew the tenant RECONNECT lease ONLY while the OBS source is present. When the
    // source is gone we deliberately do NOT bump renew_deadline, so the lease lapses
    // after RECONNECT_GRACE_MS (3 min) and the sweeper reaps this tenant + its GPU
    // backend — while a reconnect inside the window keeps the slot. This is the
    // forgiving replacement for the legacy 20s OBS-disconnect kill, and it is what
    // drops the tenant out of the DERIVED hub-emptiness count.
    await supabase.from('gpu_instances')
      .update({
        last_seen_at: nowIso, streaming, idle_since: idleSince, burn_rate: bill.burnRate,
        // Per-platform runner states for the dock's status dots (/api/gpu/status reads
        // this column). The reaped all-in-one pod heartbeat used to be the writer; the
        // hub is now the sole producer. Default [] so a tenant that reports no outputs
        // (OBS not publishing) clears stale dots rather than freezing them.
        outputs: r?.outputs ?? [],
        ...(streaming ? { renew_deadline: new Date(now + RECONNECT_GRACE_MS).toISOString() } : {}),
      })
      .eq('user_id', userId).eq('vps_hub_id', hubId)

    // Coarse inbound (OBS→hub) health for the dock graph in hub topology. `streaming`
    // here = OBS is publishing to this tenant's SRT path (honest source-present signal).
    // The rich per-platform OUTBOUND series needs encoder states the VPS doesn't report
    // yet (deferred); the bridge series comes from the GPU backend's own heartbeat.
    if (s.id) {
      supabase.from('connection_metrics').insert({
        instance_id: s.id as string, user_id: userId, direction: 'inbound',
        platform: null, bitrate_kbps: null, health_score: streaming ? 100 : 0, dropped_frames: 0,
      }).then(() => {})
    }

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

  // Scale-to-zero (Clock B, timely path): reconcile emptiness from the DERIVED
  // live-lease count (NOT a stored refcount — the wedged-counter immortal-hub
  // orphan is structurally impossible now). reconcile_hub_emptiness recomputes
  // count(tenants WHERE renew_deadline > now()) AFTER the Clock A loop above, so a
  // tenant that just renewed its lease this beat is counted; if zero past grace,
  // self-destruct now rather than waiting for the sweeper/cron.
  const { data: rec } = await supabase.rpc('reconcile_hub_emptiness', { p_hub_id: hubId })
  const recRow = (rec as Array<{ out_active_count: number; out_empty_since: string | null }> | null)?.[0]
  if (
    recRow && recRow.out_active_count === 0 && recRow.out_empty_since &&
    (now - new Date(recRow.out_empty_since).getTime()) > HUB_IDLE_GRACE_MS
  ) {
    console.log(`[agent/status] hub ${hubId} empty past grace — scale-to-zero`)
    // onlyIfEmpty: the claim RPC re-checks the derived count under a row lock — a
    // tenant that raced in is committed-and-counted and aborts the destroy.
    await teardownHub(hubId, 'scale_to_zero', { onlyIfEmpty: true })
    return Response.json({ command: 'stop', reason: 'scale_to_zero' })
  }

  // Heartbeat-driven universal sweep (drops the old isPodAgent gate): a hub beat
  // reaps any stale pod / hub / gpu-backend across the fleet within ~1 beat. after() so
  // it completes post-response (review #7), not as a freezable floating promise.
  after(() => sweepExpiredLeases().catch(e => console.error('[sweep] hub-beat error:', e)))

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
    return handleGpuStatus(request, node)
  }

  const authed = await authenticateAgentDetailed(request)
  if (!authed) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Heartbeat-driven universal sweep — runs on EVERY agent beat (the old isPodAgent
  // gate is gone; the hub + gpu roles also drive it from their own handlers above).
  // after() guarantees post-response completion on Vercel (review #7).
  after(() => sweepExpiredLeases().catch(e => console.error('[sweep] pod-beat error:', e)))

  return Response.json({ ok: true })
}
