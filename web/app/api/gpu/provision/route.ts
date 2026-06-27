import { createServerClient } from '@/lib/supabase'
import { generateApiKey, hashApiKey, authenticateUserOrAgent } from '@/lib/agent-auth'
import { provisionGpu, startProvisionRace, type UserOutputConfig, type RacerEntry } from '@/lib/gpu-broker'
import { teardownInstance, sweepStalePods } from '@/lib/pod-teardown'
import { checkRateLimit } from '@/lib/rate-limit'
import { FALLBACK_LAT, FALLBACK_LON } from '@/lib/datacenters'

// Vercel function timeout. v1 path: may cascade through several Vast candidates.
// v2 path: returns in ~5s (just creates N pods and returns); 300s is defensive.
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

  // Phase 0: fire-and-forget sweep (was awaited, costing the first few seconds of
  // every provision on the critical path). The heartbeat already sweeps on each beat.
  sweepStalePods().catch(e => console.error('[sweep] provision-time error:', e))

  if (!(await checkRateLimit(`provision:${userId}`, 5, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  // ── Payment gate ──────────────────────────────────────────────────────────
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
  const { data: existing } = await supabase
    .from('gpu_instances')
    .select('status, phase, last_seen_at, created_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    const fresh =
      existing.last_seen_at &&
      Date.now() - new Date(existing.last_seen_at).getTime() < FRESH_HEARTBEAT_MS
    if (existing.status === 'running' && fresh) {
      return Response.json({ error: 'Streaming server is already running' }, { status: 409 })
    }
    const provisioningRecently =
      (existing.status === 'provisioning' || existing.phase === 'racing' || existing.phase === 'requested') &&
      existing.created_at &&
      Date.now() - new Date(existing.created_at).getTime() < PROVISION_LOCK_MS
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
    })
    .select('id')
    .maybeSingle()

  if (claimErr || !claim) {
    return Response.json({ error: 'Streaming server is already starting' }, { status: 409 })
  }

  const releaseClaim = async () => {
    await supabase.from('gpu_instances').delete().eq('user_id', userId)
  }

  // Generate ephemeral pod key (separate from the user's dashboard API key).
  const podRawKey = generateApiKey()
  const podKeyHash = hashApiKey(podRawKey)

  await supabase.from('agent_api_keys').delete().eq('user_id', userId).eq('label', 'pod')
  await supabase.from('agent_api_keys').insert({ user_id: userId, key_hash: podKeyHash, label: 'pod' })

  const imageTag = process.env.SLIMCAST_RELAY_IMAGE || 'ghcr.io/oxlynum/multistream-relay:latest'
  const callbackUrl = process.env.SLIMCAST_AGENT_CALLBACK_URL ?? 'https://slimcast-oxlynum.vercel.app'

  const lat = Number(request.headers.get('x-vercel-ip-latitude')) || FALLBACK_LAT
  const lon = Number(request.headers.get('x-vercel-ip-longitude')) || FALLBACK_LON

  const ingestKey = generateApiKey().slice(0, 24)
  const srtPassphrase = generateApiKey().slice(0, 32)
  const panelPassword = generateApiKey().slice(0, 24)

  // Fetch platform config for NVENC session counting and budget ceiling.
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
  const has2kAddon = (profileBitrates as { has_2k_addon?: boolean } | null)?.has_2k_addon ?? false
  const costCeilingUsd = has2kAddon ? 1.5 : 1.0

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
    const isPassthrough = p.platform === 'youtube' && orientation === 'landscape'
    const bitrate = p.bitrate_kbps ?? (orientation === 'portrait' ? portraitCap : landscapeCap)
    return { orientation, resolution: '1080p', bitrate_kbps: bitrate, mode: isPassthrough ? 'passthrough' : 'transcode', enabled: p.enabled }
  })

  const podEnv = [
    { key: 'SLIMCAST_API_KEY',        value: podRawKey },
    { key: 'SLIMCAST_VERCEL_URL',     value: callbackUrl },
    { key: 'SLIMCAST_INGEST_KEY',     value: ingestKey },
    { key: 'SLIMCAST_SRT_PASSPHRASE', value: srtPassphrase },
    { key: 'RELAY_PASSWORD',          value: panelPassword },
    { key: 'SLIMCAST_COST_CEILING_USD', value: String(costCeilingUsd) },
    { key: 'SOURCE_WIDTH',            value: String(srcW) },
    { key: 'SOURCE_HEIGHT',           value: String(srcH) },
  ]

  // Save secrets + geo on the claim row immediately, so the /api/agent/ready
  // handler can build the srt_url and the /api/agent/failed handler can re-create
  // pods with the same secrets when kicking the next round.
  await supabase.from('gpu_instances').update({
    pod_key_hash: podKeyHash,
    ingest_key: ingestKey,
    srt_passphrase: srtPassphrase,
    panel_password: panelPassword,
    provision_lat: lat,
    provision_lon: lon,
  }).eq('user_id', userId)

  // ── Broker path selection ──────────────────────────────────────────────────
  const useV2 = process.env.SLIMCAST_BROKER_V2 !== 'false'  // default ON

  if (useV2) {
    return runV2Race({ userId, lat, lon, imageTag, podEnv, userOutputs, claim, supabase, releaseClaim })
  } else {
    return runV1Cascade({ userId, lat, lon, imageTag, podEnv, userOutputs, ingestKey, srtPassphrase, panelPassword, podKeyHash, claim, supabase, releaseClaim })
  }
}

// ── v2: async parallel race ───────────────────────────────────────────────────

async function runV2Race({ userId, lat, lon, imageTag, podEnv, userOutputs, supabase, releaseClaim }: {
  userId: string; lat: number; lon: number; imageTag: string
  podEnv: { key: string; value: string }[]; userOutputs: UserOutputConfig[]
  claim: { id: string }; supabase: ReturnType<typeof createServerClient>
  releaseClaim: () => Promise<void>
}) {
  // Update phase to 'requested' before kicking the race.
  await supabase.from('gpu_instances').update({ phase: 'requested' }).eq('user_id', userId)

  const podName = `slimcast-${userId.slice(0, 8)}`

  // Serialize racer writes: both pods in a round call onRacerCreated concurrently.
  // Without this lock the second write races the first and overwrites it, leaving
  // one racer invisible to /api/agent/failed (which then wrongly declares all dead
  // and rotates the key before the invisible pod can pair).
  let racerWriteLock = Promise.resolve()
  const raceResult = await startProvisionRace({
    lat, lon,
    name: podName,
    imageTag,
    env: podEnv,
    userOutputs,
    racersN: 2,
    onRacerCreated: async (racer: RacerEntry) => {
      await (racerWriteLock = racerWriteLock.then(async () => {
        const { data: row } = await supabase
          .from('gpu_instances')
          .select('racers')
          .eq('user_id', userId)
          .maybeSingle()
        const current = (row?.racers ?? []) as RacerEntry[]
        current.push(racer)
        await supabase.from('gpu_instances')
          .update({ racers: current, phase: 'racing', status: 'provisioning' })
          .eq('user_id', userId)
      }))
    },
  })

  if (!raceResult.started) {
    console.error(`[provision/v2] no candidates for user ${userId}: ${raceResult.error}`)
    await supabase.from('agent_api_keys').delete().eq('user_id', userId).eq('label', 'pod')
    await releaseClaim()
    return Response.json(
      { error: 'No GPU capacity available right now.', detail: raceResult.error },
      { status: 503 },
    )
  }

  console.log(`[provision/v2] race started for user ${userId}: ${raceResult.racerCount} racer(s)`)
  return Response.json({ ok: true, racing: true, racers: raceResult.racerCount })
}

// ── v1: synchronous cascade (Phase 0 improvements applied) ───────────────────

async function runV1Cascade({ userId, lat, lon, imageTag, podEnv, userOutputs, ingestKey, srtPassphrase, panelPassword, podKeyHash, supabase, releaseClaim }: {
  userId: string; lat: number; lon: number; imageTag: string
  podEnv: { key: string; value: string }[]; userOutputs: UserOutputConfig[]
  ingestKey: string; srtPassphrase: string; panelPassword: string; podKeyHash: string
  claim: { id: string }; supabase: ReturnType<typeof createServerClient>
  releaseClaim: () => Promise<void>
}) {
  const result = await provisionGpu({
    lat, lon,
    name: `slimcast-${userId.slice(0, 8)}`,
    imageTag,
    env: podEnv,
    userOutputs,
    // Record provider_id immediately after creation (before probes) so teardown
    // can destroy the pod even if this function is killed mid-cascade.
    onPodCreated: async (podId, provider) => {
      await supabase.from('gpu_instances').update({ provider_id: podId, provider }).eq('user_id', userId)
    },
    // Phase 0: save the SRT URL right after IP/ports are known — before RTMP probes.
    // A kill during probing can no longer strand a healthy pod with no saved URL.
    onAddrKnown: async ({ ip, rtmpPort, srtPort }) => {
      console.log(`[provision/v1] saving addr early: ip=${ip} srt_port=${srtPort} rtmp_port=${rtmpPort}`)
      await supabase.from('gpu_instances').update({
        ip_address: ip,
        ingest_port: rtmpPort,
        srt_port: srtPort,
        // Secrets are already on the row from the early save above; this is
        // a belt-and-suspenders re-save in case the earlier update lost a race.
        ingest_key: ingestKey,
        srt_passphrase: srtPassphrase,
        panel_password: panelPassword,
      }).eq('user_id', userId)
    },
  })

  if (!result.ok) {
    console.error(`[provision/v1] broker exhausted after ${result.attempts} attempts:`, result.error)
    await supabase.from('agent_api_keys').delete().eq('key_hash', podKeyHash)
    await releaseClaim()
    return Response.json(
      { error: 'No GPU capacity available right now.', detail: result.error ?? `tried ${result.attempts} option(s)` },
      { status: 503 },
    )
  }

  console.log(`[provision/v1] pod ready: ip=${result.ip} srt_port=${result.srtPort} rtmp_port=${result.port} key=${ingestKey.slice(0, 8)}… (srt_url ${result.ip && result.srtPort ? 'DELIVERABLE' : 'INCOMPLETE'})`)
  const { error: saveErr } = await supabase.from('gpu_instances').update({
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
  }).eq('user_id', userId)
  if (saveErr) console.error(`[provision/v1] FAILED to save ingest coords: ${saveErr.message}`)

  return Response.json({ ok: true, gpu: result.gpuKey, datacenter: result.datacenter, attempts: result.attempts })
}
