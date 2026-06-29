import { createServerClient } from '@/lib/supabase'
import { generateApiKey, authenticateUserOrAgent } from '@/lib/agent-auth'
import { type UserOutputConfig } from '@/lib/gpu-broker'
import { acquireHubOrSpawn, startGpuBackendRace } from '@/lib/vps-broker'
import { classifyMode, needsTranscode } from '@/lib/agent-config'
import { teardownInstance, sweepExpiredLeases } from '@/lib/pod-teardown'
import { checkRateLimit } from '@/lib/rate-limit'
import { spendableTokens } from '@/lib/billing'
import { FALLBACK_LAT, FALLBACK_LON, VPS_READINESS_TIMEOUT_MS, PROVISION_LEASE_MS } from '@/lib/datacenters'

// Billing master switch (shared with the heartbeat clock). When off, streaming is free
// in dev — the payment gate below is skipped entirely.
const BILLING_ACTIVE = process.env.SLIMCAST_BILLING_ACTIVE === 'true'

// Vercel function timeout. The hub-spawn path may boot a fresh VPS hub (and, for a
// transcode tenant, race a GPU backend) before returning; 300s is defensive.
export const maxDuration = 300

// A running pod is considered live (not reclaimable) only if it has heartbeat
// within this window. Past it the agent is presumed dead and the slot is free.
const FRESH_HEARTBEAT_MS = 150_000
// A provisioning row younger than this means another request is mid-boot; don't
// reclaim it (it would strand the in-flight pod).
const PROVISION_LOCK_MS = 3 * 60 * 1000
// Force-confirm window: a session is hard-killed at created_at + this.
const MAX_SESSION_MS = 12 * 60 * 60 * 1000

export async function POST(request: Request) {
  const supabase = createServerClient()

  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  console.log(`[provision] user=${userId} ua=${request.headers.get('user-agent') ?? 'unknown'}`)

  // ⚠️ TEMPORARY PRIVATE-DEV GATE — DELETE BEFORE PRODUCTION (see vps-hub-phase1.md).
  // While the VPS-hub is in development, restrict ALL streaming (both the VPS and
  // all-in-one paths) to an allowlist of emails (SLIMCAST_ALLOWED_EMAILS, comma-
  // separated). Unset/empty = open (no gate). Fail-OPEN on a lookup error so a
  // transient blip can't lock out the legit user. REMOVE this whole block at launch.
  const devAllowlist = (process.env.SLIMCAST_ALLOWED_EMAILS ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (devAllowlist.length) {
    try {
      const { data: u } = await supabase.auth.admin.getUserById(userId)
      const email = (u?.user?.email ?? '').toLowerCase()
      if (email && !devAllowlist.includes(email)) {
        console.warn(`[provision] private-dev gate: blocked ${email}`)
        return Response.json(
          { error: 'SlimCast is in private development — your account is not enabled yet.' },
          { status: 403 },
        )
      }
    } catch (e) {
      console.warn('[provision] private-dev gate lookup failed (allowing):', e instanceof Error ? e.message : e)
    }
  }

  // Phase 0: fire-and-forget sweep (was awaited, costing the first few seconds of
  // every provision on the critical path). The heartbeat already sweeps on each beat.
  sweepExpiredLeases().catch(e => console.error('[sweep] provision-time error:', e))

  if (!(await checkRateLimit(`provision:${userId}`, 5, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  // ── Payment gate (Phase 3: plan-aware) ─────────────────────────────────────
  // Skipped entirely when billing is off (free dev streaming) or for the dev-bypass
  // user. Spendable = rolling allotment (subscribers) + purchased balance; the 2-token
  // free trial (profiles.streaming_credits DEFAULT) lets a brand-new account stream
  // without a card. A zero balance is allowed only if auto-refill is armed.
  const UUID_RE_GATE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const gateBypassId = process.env.SLIMCAST_DEV_NO_BILLING_USER_ID ?? ''
  const skipPaymentGate = !!userId && UUID_RE_GATE.test(gateBypassId) && gateBypassId === userId
  if (skipPaymentGate) console.log(`[provision] dev payment gate bypassed for ${userId}`)
  if (BILLING_ACTIVE && !skipPaymentGate) {
    const { data: gate } = await supabase
      .from('profiles')
      .select('plan, allotment_tokens, streaming_credits, auto_refill_enabled')
      .eq('id', userId)
      .single()

    const spendable = spendableTokens(gate)
    if (spendable <= 0 && !gate?.auto_refill_enabled) {
      return Response.json(
        { error: 'out_of_credits', message: 'You are out of streaming time. Add credits, enable auto-refill, or subscribe.' },
        { status: 402 },
      )
    }
  }

  // ── Atomic provisioning claim ──────────────────────────────────────────
  const { data: existing } = await supabase
    .from('gpu_instances')
    .select('status, phase, last_seen_at, created_at, vps_hub_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    const fresh =
      existing.last_seen_at &&
      Date.now() - new Date(existing.last_seen_at).getTime() < FRESH_HEARTBEAT_MS
    if (existing.status === 'running' && fresh) {
      return Response.json({ error: 'Streaming server is already running' }, { status: 409 })
    }
    // A VPS-hub tenant stays 'provisioning' until its hub POSTs /ready — up to the
    // hub boot window (5m), longer than a GPU pod's 3m lock. Use the wider window so
    // a re-provision during a normal slow first boot doesn't reclaim the in-flight
    // tenant (which would rotate its streamid mid-boot) (review #9).
    const lockWindow = existing.vps_hub_id ? VPS_READINESS_TIMEOUT_MS : PROVISION_LOCK_MS
    const provisioningRecently =
      (existing.status === 'provisioning' || existing.phase === 'racing' || existing.phase === 'requested') &&
      existing.created_at &&
      Date.now() - new Date(existing.created_at).getTime() < lockWindow
    if (provisioningRecently) {
      return Response.json({ error: 'Streaming server is already starting' }, { status: 409 })
    }
    await teardownInstance(userId, 'provision_reclaim')
  }

  const { data: claim, error: claimErr } = await supabase
    .from('gpu_instances')
    .insert({
      user_id: userId,
      provider_id: '',
      status: 'provisioning',
      max_session_at: new Date(Date.now() + MAX_SESSION_MS).toISOString(),
      // Boot-window lease so a pod that boots a real box but dies before its first
      // heartbeat is swept in ~PROVISION_LEASE_MS+grace instead of leaking until the 12h
      // max_session cap (review #4/#5). The 10s heartbeat renews it to BOX_LEASE_MS once
      // the agent is alive; attach_session_to_hub overwrites it for a hub tenant.
      renew_deadline: new Date(Date.now() + PROVISION_LEASE_MS).toISOString(),
    })
    .select('id')
    .maybeSingle()

  if (claimErr || !claim) {
    return Response.json({ error: 'Streaming server is already starting' }, { status: 409 })
  }

  const releaseClaim = async () => {
    await supabase.from('gpu_instances').delete().eq('user_id', userId)
  }

  const imageTag = process.env.SLIMCAST_RELAY_IMAGE || 'ghcr.io/oxlynum/multistream-relay:latest'
  const callbackUrl = process.env.SLIMCAST_AGENT_CALLBACK_URL ?? 'https://slimcast-oxlynum.vercel.app'

  const lat = Number(request.headers.get('x-vercel-ip-latitude')) || FALLBACK_LAT
  const lon = Number(request.headers.get('x-vercel-ip-longitude')) || FALLBACK_LON

  const ingestKey = generateApiKey().slice(0, 24)

  // Fetch platform config for NVENC session counting and budget ceiling.
  const [{ data: profileBitrates }, { data: platformRows }] = await Promise.all([
    supabase
      .from('profiles')
      .select('landscape_bitrate_kbps, portrait_bitrate_kbps')
      .eq('id', userId)
      .single(),
    supabase
      .from('platform_connections')
      .select('platform, orientation, enabled, bitrate_kbps, twitch_hevc_eligible, twitch_use_passthrough')
      .eq('user_id', userId),
  ])

  const landscapeCap: number = (profileBitrates as { landscape_bitrate_kbps?: number } | null)?.landscape_bitrate_kbps ?? 6000
  const portraitCap: number  = (profileBitrates as { portrait_bitrate_kbps?: number } | null)?.portrait_bitrate_kbps ?? 4000

  const userOutputs: UserOutputConfig[] = (platformRows ?? []).map((p: {
    platform: string; orientation: string | null; enabled: boolean; bitrate_kbps: number | null
    twitch_hevc_eligible?: boolean | null; twitch_use_passthrough?: boolean | null
  }) => {
    const orientation = p.orientation ?? 'landscape'
    // Mode-aware (mirrors agent-config exactly — landmine #10): an eligible-Twitch
    // eRTMP stream is passthrough-class (no NVENC), so it must NOT force a GPU rental.
    const mode = classifyMode(p.platform, orientation, p.twitch_hevc_eligible, p.twitch_use_passthrough)
    const bitrate = p.bitrate_kbps ?? (orientation === 'portrait' ? portraitCap : landscapeCap)
    return { orientation, resolution: '1080p', bitrate_kbps: bitrate, mode, enabled: p.enabled }
  })

  // VPS-as-the-Hub: a stream with zero GPU-needing outputs (all passthrough/ertmp)
  // can run on a card-less VPS hub. needsGpu gates the S5 broker branch below.
  const needsGpu = needsTranscode(userOutputs)

  // Persist the tenant streamid (ingest_key) + provision geo on the claim row now.
  // hub-config reads ingest_key as this tenant's streamid; the geo is kept for ranking.
  await supabase.from('gpu_instances').update({
    ingest_key: ingestKey,
    provision_lat: lat,
    provision_lon: lon,
  }).eq('user_id', userId)

  // ── VPS-as-the-Hub path ──────────────────────────────────────
  // EVERY stream ingests to the VPS hub first — passthrough (YouTube/eligible-Twitch)
  // delivers VPS-direct; transcode (Kick/TikTok/non-eligible-Twitch) bridges to a GPU
  // backend behind the hub. No user ever goes straight to a GPU.
  const hub = await acquireHubOrSpawn({ userId, lat, lon, imageTag, callbackUrl, supabase })
  if (!hub.ok) {
    await releaseClaim()
    return Response.json({ error: 'No VPS capacity available right now.', detail: hub.error }, { status: 503 })
  }

  if (needsGpu) {
    // Transcode tenant: race a GPU backend anchored on the HUB's region (across all
    // backend providers). acquireHubOrSpawn's attach() set topology='passthrough_only';
    // startGpuBackendRace overrides it to 'vps_gpu' + links the gpu_backend node.
    // On no-capacity it DEGRADES (passthrough keeps serving) — never direct-to-GPU.
    const gpu = await startGpuBackendRace({
      userId, instanceId: claim.id, hubLat: hub.lat ?? null, hubLon: hub.lon ?? null,
      imageTag, callbackUrl, userOutputs, supabase,
    })
    console.log(`[provision] VPS hub + GPU bridge for ${userId}: hub=${hub.hubId} status=${hub.status} gpu=${gpu.ok ? gpu.nodeId : 'NO-CAPACITY(' + gpu.error + ')'}`)
  } else {
    console.log(`[provision] VPS hub ${hub.attached ? 'attached' : 'spawned'} for ${userId}: hub=${hub.hubId} status=${hub.status} region=${hub.region}`)
  }
  return Response.json({ ok: true, vps_hub: true, attached: hub.attached, status: hub.status, needs_gpu: needsGpu })
}
