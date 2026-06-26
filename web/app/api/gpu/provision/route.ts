import { createServerClient } from '@/lib/supabase'
import { generateApiKey, hashApiKey, authenticateUserOrAgent } from '@/lib/agent-auth'
import { provisionGpu, type UserOutputConfig } from '@/lib/gpu-broker'
import { teardownInstance, sweepStalePods } from '@/lib/pod-teardown'
import { checkRateLimit } from '@/lib/rate-limit'
import { FALLBACK_LAT, FALLBACK_LON } from '@/lib/datacenters'

// Vercel function timeout: the broker can cascade through several Vast candidates
// (each up to READINESS_TIMEOUT_MS = 3 min) before returning. Explicit 300s cap
// matches what the OBS plugin expects (setTransferTimeout(300000)).
export const maxDuration = 300

// A running pod is considered live (not reclaimable) only if it has heartbeat
// within this window. Past it the agent is presumed dead and the slot is free.
const FRESH_HEARTBEAT_MS = 150_000
// A provisioning row younger than this means another request is mid-boot; don't
// reclaim it (it would strand the in-flight pod). The boot/readiness gate is
// well under this, so a genuinely stuck claim is reclaimable after it.
const PROVISION_LOCK_MS = 3 * 60 * 1000
// Force-confirm window: a session is hard-killed at created_at + this.
const MAX_SESSION_MS = 12 * 60 * 60 * 1000

export async function POST(request: Request) {
  const supabase = createServerClient()

  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Audit log: surfaces random/unexpected provision calls in Vercel logs.
  console.log(`[provision] user=${userId} ua=${request.headers.get('user-agent') ?? 'unknown'}`)

  // Opportunistic sweep: destroy any stale pods across all users before we
  // create a new one. Covers the daily-cron gap without paid cron calls.
  await sweepStalePods()

  // Rate limit: a handful of provisions per minute per user is plenty for a
  // human; this caps any scripted spam that would create orphan pods.
  if (!(await checkRateLimit(`provision:${userId}`, 5, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  // ── Payment gate: no pod may ever run without a card on file AND a way to
  // pay for it. This is the hard stop against "run pods without paying" and
  // against multi-account free-GPU abuse (a card is the anti-sybil signal). ──
  // DEV bypass: same UUID guard as the billing bypass — must be a well-formed
  // UUID, exact match only, never affects any other account.
  const UUID_RE_GATE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const gateBypassId = process.env.SLIMCAST_DEV_NO_BILLING_USER_ID ?? ''
  const skipPaymentGate = !!userId && UUID_RE_GATE.test(gateBypassId) && gateBypassId === userId
  if (skipPaymentGate) console.log(`[provision] dev payment gate bypassed for ${userId}`)
  if (!skipPaymentGate) {
    const { data: gate } = await supabase
      .from('profiles')
      .select('stripe_payment_method_id, streaming_credits, auto_refill_enabled')
      .eq('id', userId)
      .single()

    if (!gate?.stripe_payment_method_id) {
      return Response.json(
        { error: 'payment_method_required', message: 'Add a payment method before streaming.' },
        { status: 402 },
      )
    }
    const credits = parseFloat(gate.streaming_credits ?? '0') || 0
    if (credits <= 0 && !gate.auto_refill_enabled) {
      return Response.json(
        { error: 'out_of_credits', message: 'You are out of streaming time. Add credits or enable auto-refill.' },
        { status: 402 },
      )
    }
  }

  // ── Atomic provisioning claim ──────────────────────────────────────────
  // The orphan-pod bug: if we created the pod before reserving the row, two
  // concurrent calls would each boot a pod but only one would be recorded —
  // the other bills forever, unseen by every teardown path. So we reserve the
  // row FIRST. The unique(user_id) constraint makes the insert the lock.
  const { data: existing } = await supabase
    .from('gpu_instances')
    .select('status, last_seen_at, created_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    const fresh =
      existing.last_seen_at &&
      Date.now() - new Date(existing.last_seen_at).getTime() < FRESH_HEARTBEAT_MS
    if (existing.status === 'running' && fresh) {
      return Response.json({ error: 'Streaming server is already running' }, { status: 409 })
    }
    // A recently-created provisioning row = another request is mid-boot. Don't
    // reclaim it (that could strand its in-flight pod) — tell the caller to wait.
    const provisioningRecently =
      existing.status === 'provisioning' &&
      existing.created_at &&
      Date.now() - new Date(existing.created_at).getTime() < PROVISION_LOCK_MS
    if (provisioningRecently) {
      return Response.json({ error: 'Streaming server is already starting' }, { status: 409 })
    }
    // Stale / stopped / errored row: destroy any old pod and free the slot so
    // the claim insert below can take it (never overwrite a row that still
    // points at a live pod — that's how orphans are born).
    await teardownInstance(userId, 'provision_reclaim')
  }

  // Insert-as-lock. If a concurrent request already claimed, this conflicts on
  // unique(user_id) and we bail WITHOUT creating a pod.
  const { data: claim, error: claimErr } = await supabase
    .from('gpu_instances')
    .insert({
      user_id: userId,
      provider_id: '',
      status: 'provisioning',
      max_session_at: new Date(Date.now() + MAX_SESSION_MS).toISOString(),
    })
    .select('id')
    .maybeSingle()

  if (claimErr || !claim) {
    return Response.json({ error: 'Streaming server is already starting' }, { status: 409 })
  }

  // From here on, the claim row exists. Any early return MUST release it.
  const releaseClaim = async () => {
    await supabase.from('gpu_instances').delete().eq('user_id', userId)
  }

  // Generate a fresh ephemeral key for the pod — separate from the user's
  // dashboard API key so provisioning doesn't invalidate the OBS plugin setup.
  const podRawKey = generateApiKey()
  const podKeyHash = hashApiKey(podRawKey)

  // Remove any stale pod key for this user before inserting the new one.
  await supabase
    .from('agent_api_keys')
    .delete()
    .eq('user_id', userId)
    .eq('label', 'pod')

  await supabase.from('agent_api_keys').insert({
    user_id: userId,
    key_hash: podKeyHash,
    label: 'pod',
  })

  // `||` not `??`: an empty-string env var should still fall back to the default.
  const imageTag = process.env.SLIMCAST_RELAY_IMAGE || 'ghcr.io/oxlynum/multistream-relay:latest'

  // Where the pod's agent phones home. slimcast.com isn't owned yet, so this
  // deployment's vercel.app URL is passed explicitly.
  const callbackUrl =
    process.env.SLIMCAST_AGENT_CALLBACK_URL ?? 'https://slimcast-oxlynum.vercel.app'

  // User location from Vercel's geolocation headers → provision the nearest
  // available GPU. Falls back to central US when headers are absent (local dev).
  const lat = Number(request.headers.get('x-vercel-ip-latitude')) || FALLBACK_LAT
  const lon = Number(request.headers.get('x-vercel-ip-longitude')) || FALLBACK_LON

  // Per-pod secret used as the RTMP ingest path, so only OBS holding this key
  // can publish to the pod (no more open "live" ingest on a public port).
  const ingestKey = generateApiKey().slice(0, 24)

  // Per-pod SRT AES passphrase (32 chars — within SRT's 10–79 requirement).
  // Encrypts the OBS→pod HEVC uplink in flight; MediaMTX requires it to publish
  // AND read the path, so the secret streamid is no longer the only protection.
  // Stored on the row so /api/gpu/status can hand it to the OBS plugin (it rides
  // in srt_url) and the agent can substitute it into MediaMTX.
  const srtPassphrase = generateApiKey().slice(0, 32)

  // Per-pod debug-panel password, replacing the shared weak RELAY_PASSWORD.
  // app.py fails closed without it so it's always set; per-pod means leaking one
  // pod's panel can never reach another's. Stored so we can reach the panel to debug.
  const panelPassword = generateApiKey().slice(0, 24)

  // Fetch the user's platform connections to determine how many simultaneous
  // NVENC sessions their config requires. Consumer GPUs (GeForce RTX 3090/4090/5090)
  // are capped at 3 concurrent sessions in hardware; if the user needs more the
  // broker skips them automatically.
  //
  // NOTE: per-output resolution overrides (from the output-settings feature) are
  // not yet wired here — when that lands, pull from the output_settings table and
  // replace the hardcoded '1080p' default below with the per-platform value.
  const [{ data: profileBitrates }, { data: platformRows }] = await Promise.all([
    supabase
      .from('profiles')
      .select('landscape_bitrate_kbps, portrait_bitrate_kbps, has_2k_addon, output_settings')
      .eq('id', userId)
      .single(),
    supabase
      .from('platform_connections')
      .select('platform, orientation, enabled, bitrate_kbps')
      .eq('user_id', userId),
  ])

  const landscapeCap: number = (profileBitrates as { landscape_bitrate_kbps?: number } | null)?.landscape_bitrate_kbps ?? 6000
  const portraitCap: number  = (profileBitrates as { portrait_bitrate_kbps?: number } | null)?.portrait_bitrate_kbps ?? 4000

  // Budget ceiling the pod's throttle controller targets. 2K add-on holders pay
  // +0.5 token/hr (~+$1 revenue), which funds a higher infra ceiling so they keep
  // 1440p far longer before throttling kicks in. Standard users: hard $1/hr.
  const has2kAddon = (profileBitrates as { has_2k_addon?: boolean } | null)?.has_2k_addon ?? false
  const costCeilingUsd = has2kAddon ? 1.5 : 1.0

  // Source canvas dimensions for the pod (crop math + the throttle controller's
  // resolution-downscale guard, which must know the true source height to know how
  // far it can scale down). Derived from the highest landscape resolution the user
  // has configured; defaults to 1080p. Only a 2K add-on holder reaches 1440p.
  const outputSettings = ((profileBitrates as { output_settings?: Record<string, { resolution?: string }> } | null)?.output_settings) ?? {}
  const maxResLabel = Object.values(outputSettings)
    .map(s => s?.resolution)
    .reduce<string>((best, r) => {
      const rank = (x?: string) => (x === '1440p' ? 3 : x === '1080p' ? 2 : x === '720p' ? 1 : 0)
      return rank(r) > rank(best) ? (r as string) : best
    }, '1080p')
  const [srcW, srcH] = has2kAddon && maxResLabel === '1440p'
    ? [2560, 1440]
    : maxResLabel === '720p'
      ? [1280, 720]
      : [1920, 1080]

  const userOutputs: UserOutputConfig[] = (platformRows ?? []).map((p: {
    platform: string; orientation: string | null; enabled: boolean; bitrate_kbps: number | null
  }) => {
    const orientation = p.orientation ?? 'landscape'
    // YouTube landscape is HEVC passthrough — no NVENC session needed.
    const isPassthrough = p.platform === 'youtube' && orientation === 'landscape'
    const bitrate = p.bitrate_kbps ?? (orientation === 'portrait' ? portraitCap : landscapeCap)
    return {
      orientation,
      resolution: '1080p',
      bitrate_kbps: bitrate,
      mode: isPassthrough ? 'passthrough' : 'transcode',
      enabled: p.enabled,
    }
  })

  const result = await provisionGpu({
    lat,
    lon,
    name: `slimcast-${userId.slice(0, 8)}`,
    imageTag,
    env: [
      { key: 'SLIMCAST_API_KEY', value: podRawKey },
      { key: 'SLIMCAST_VERCEL_URL', value: callbackUrl },
      { key: 'SLIMCAST_INGEST_KEY', value: ingestKey },
      { key: 'SLIMCAST_SRT_PASSPHRASE', value: srtPassphrase },
      // Per-pod panel password (not the shared process.env.RELAY_PASSWORD anymore).
      { key: 'RELAY_PASSWORD', value: panelPassword },
      // Budget-throttle ceiling ($/hr). GPU rate + per-TB bandwidth prices are
      // injected separately by the provider's create() (only known from the offer).
      { key: 'SLIMCAST_COST_CEILING_USD', value: String(costCeilingUsd) },
      // Source canvas dims — crop math + the resolution-downscale guard rely on
      // knowing the true source height (so a 1440p stream can be capped to 1080p).
      { key: 'SOURCE_WIDTH', value: String(srcW) },
      { key: 'SOURCE_HEIGHT', value: String(srcH) },
    ],
    userOutputs,
    // Save provider_id the moment a pod is created — before any readiness probe —
    // so teardownInstance can destroy the pod even if this function is killed
    // mid-cascade by Vercel's maxDuration (otherwise provider_id stays '' and
    // teardown skips the provider destroy, letting the pod run and bill forever).
    onPodCreated: async (podId, provider) => {
      await supabase
        .from('gpu_instances')
        .update({ provider_id: podId, provider })
        .eq('user_id', userId)
    },
  })

  if (!result.ok) {
    console.error(`[provision] broker exhausted after ${result.attempts} attempts:`, result.error)
    // Clean up the unused pod key AND release the claim so the user can retry.
    await supabase.from('agent_api_keys').delete().eq('key_hash', podKeyHash)
    await releaseClaim()
    return Response.json(
      {
        error: 'No GPU capacity available right now.',
        message: 'No GPU capacity available right now. Please retry in a moment.',
        detail: result.error ?? `tried ${result.attempts} option(s)`,
      },
      { status: 503 },
    )
  }

  // Pod is up — fill in the claim row with the real provider details. Do NOT
  // touch status or last_seen_at here: if the agent already paired (it can race
  // waitForIp by a few seconds when the image is cached), overwriting status back
  // to 'provisioning' or clearing last_seen_at would permanently hide it from the
  // dock's stale check and keep the dock stuck on "Booting server..." forever.
  // The claim INSERT set status='provisioning'; the pair route flips it to 'running'.
  // Log the exact ingest coordinates the dock will receive — if a stream ever fails
  // to start, this line confirms whether srt_url was deliverable (ip + srt_port +
  // ingest_key all present) and when, vs. the pod being torn down before this save.
  console.log(`[provision] pod ready, saving ingest: ip=${result.ip} srt_port=${result.srtPort} rtmp_port=${result.port} key=${ingestKey.slice(0, 8)}… (srt_url ${result.ip && result.srtPort ? 'DELIVERABLE' : 'INCOMPLETE'})`)
  const { error: saveErr } = await supabase
    .from('gpu_instances')
    .update({
      provider_id: result.podId!,
      pod_key_hash: podKeyHash,
      ip_address: result.ip ?? null,
      ingest_port: result.port ?? null,
      hls_port: result.hlsPort ?? null,
      srt_port: result.srtPort ?? null,
      ingest_key: ingestKey,
      srt_passphrase: srtPassphrase,
      panel_password: panelPassword,
      provider: result.provider,
      gpu_type: result.gpuKey,
      datacenter: result.datacenter,
    })
    .eq('user_id', userId)
  if (saveErr) console.error(`[provision] FAILED to save ingest coords (row gone?): ${saveErr.message}`)

  return Response.json({
    ok: true,
    gpu: result.gpuKey,
    datacenter: result.datacenter,
    attempts: result.attempts,
  })
}
