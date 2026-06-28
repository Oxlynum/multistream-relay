import { createServerClient } from '@/lib/supabase'
import { generateApiKey, hashApiKey, authenticateUserOrAgent } from '@/lib/agent-auth'
import { provisionGpu, startProvisionRace, type UserOutputConfig, type RacerEntry } from '@/lib/gpu-broker'
import { acquireHubOrSpawn, startGpuBackendRace } from '@/lib/vps-broker'
import { classifyMode, needsTranscode } from '@/lib/agent-config'
import { teardownInstance, sweepStalePods } from '@/lib/pod-teardown'
import { checkRateLimit } from '@/lib/rate-limit'
import { spendableTokens } from '@/lib/billing'
import { FALLBACK_LAT, FALLBACK_LON, VPS_READINESS_TIMEOUT_MS } from '@/lib/datacenters'

// Billing master switch (shared with the heartbeat clock). When off, streaming is free
// in dev — the payment gate below is skipped entirely.
const BILLING_ACTIVE = process.env.SLIMCAST_BILLING_ACTIVE === 'true'

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
  sweepStalePods().catch(e => console.error('[sweep] provision-time error:', e))

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
      .select('platform, orientation, enabled, bitrate_kbps, twitch_hevc_eligible, twitch_use_passthrough')
      .eq('user_id', userId),
  ])

  const landscapeCap: number = (profileBitrates as { landscape_bitrate_kbps?: number } | null)?.landscape_bitrate_kbps ?? 6000
  const portraitCap: number  = (profileBitrates as { portrait_bitrate_kbps?: number } | null)?.portrait_bitrate_kbps ?? 4000
  const has2kAddon = (profileBitrates as { has_2k_addon?: boolean } | null)?.has_2k_addon ?? false
  const costCeilingUsd = has2kAddon ? 1.0 : 0.5

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

  // ── VPS-as-the-Hub path (behind flag) ──────────────────────────────────────
  // EVERY stream ingests to the VPS hub first — passthrough (YouTube/eligible-Twitch)
  // delivers VPS-direct; transcode (Kick/TikTok/non-eligible-Twitch) bridges to a GPU
  // backend behind the hub. No user ever goes straight to a GPU. Inert until the flag.
  if (process.env.SLIMCAST_VPS_HUB === 'true') {
    // The hub authenticates with its OWN 'vps' key; the per-user pod key minted above
    // is unused for hub sessions, so drop it.
    await supabase.from('agent_api_keys').delete().eq('user_id', userId).eq('label', 'pod')
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
