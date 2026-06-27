import type { NextRequest } from 'next/server'
import { authenticateAgent, generateApiKey, hashApiKey } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { startProvisionRace, type RacerEntry } from '@/lib/gpu-broker'
import { getProvider } from '@/lib/providers'

// Pod self-reports that it cannot serve (GPU self-test failed or fatal boot error).
//
// This lets the cloud abandon a dead host in ~1s instead of waiting out the full
// waitForIp / probeRtmp timeout (~60–180s). On success, marks that racer 'failed'
// in the racers array. If ALL racers for this session are now dead and we haven't
// exhausted our round limit, kicks the next parallel race round.
const MAX_RACE_ROUNDS = 2   // rounds 0, 1, 2 → max 3 rounds × N racers each

export async function POST(request: NextRequest) {
  const userId = await authenticateAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const { machine_id, reason, provider_id: callerProviderId } = body as {
    machine_id?: number
    reason?: string
    provider_id?: string
  }

  console.log(`[agent/failed] user=${userId} machine_id=${machine_id ?? 'unknown'} reason=${reason ?? '?'} provider_id=${callerProviderId ?? '?'}`)

  const supabase = createServerClient()

  const { data: instance } = await supabase
    .from('gpu_instances')
    .select('racers, race_round, phase, provision_lat, provision_lon, ingest_key, srt_passphrase, panel_password')
    .eq('user_id', userId)
    .maybeSingle()

  if (!instance) {
    // Row was already torn down (cancel pressed, reaper ran) — nothing to do.
    return Response.json({ ack: true })
  }

  // If the race is already won (phase='ready'/'streaming'), ignore.
  if (instance.phase === 'ready' || instance.phase === 'streaming') {
    return Response.json({ ack: true })
  }

  // Mark the calling pod as failed in the racers array.
  const racers = (instance.racers ?? []) as RacerEntry[]
  const updated: RacerEntry[] = racers.map(r => {
    const isThis = callerProviderId
      ? r.provider_id === callerProviderId
      : r.state === 'booting'  // fallback: mark the first booting entry
    return isThis ? { ...r, state: 'failed' as const } : r
  })

  await supabase.from('gpu_instances')
    .update({ racers: updated })
    .eq('user_id', userId)

  // Explicitly destroy the failing pod so it doesn't get caught in a Vast auto-restart loop
  if (callerProviderId) {
    const callerProvider = racers.find(r => r.provider_id === callerProviderId)?.provider
    if (callerProvider) {
      try {
        await getProvider(callerProvider).destroy(callerProviderId)
        console.log(`[agent/failed] destroyed failed pod ${callerProviderId}`)
      } catch (e) {
        console.error(`[agent/failed] failed to destroy ${callerProviderId}:`, e)
      }
    }
  }

  // Optionally add to the machine denylist via env for future provisions.
  // (No DB write for this yet — log is enough for now; operator can add to
  // VAST_MACHINE_DENYLIST env based on logs.)
  if (machine_id) {
    console.warn(`[agent/failed] machine_id=${machine_id} failed GPU self-test (${reason}) — consider adding to VAST_MACHINE_DENYLIST`)
  }

  // Check if ALL racers are now dead.
  const allDead = updated.every(r => r.state === 'failed' || r.state === 'loser')
  const hasWinner = updated.some(r => r.state === 'ready')

  if (!allDead || hasWinner) {
    // Still waiting on other racers, or someone already won.
    return Response.json({ ack: true })
  }

  // All racers failed. Try kicking the next round if we haven't exhausted the limit.
  const currentRound = instance.race_round ?? 0
  if (currentRound >= MAX_RACE_ROUNDS) {
    console.error(`[agent/failed] all rounds exhausted for user=${userId} — provision failed`)
    await supabase.from('gpu_instances').update({ phase: 'ended', status: 'error' }).eq('user_id', userId)
    return Response.json({ ack: true })
  }

  // CAS-increment race_round to guard against duplicate /failed POSTs double-kicking.
  const { data: bumped } = await supabase
    .from('gpu_instances')
    .update({ race_round: currentRound + 1 })
    .eq('user_id', userId)
    .eq('race_round', currentRound)   // CAS: only the request that wins this wins the kick
    .select('id')
    .maybeSingle()

  if (!bumped) {
    // Another /failed POST already won the CAS and is kicking the next round.
    return Response.json({ ack: true })
  }

  console.log(`[agent/failed] all racers dead for user=${userId}, kicking round ${currentRound + 1}`)

  // Generate a new pod API key for round 2+ so surviving round-N pods (wrong key)
  // can't authenticate to the new round's endpoints.
  const newRawKey = generateApiKey()
  const newKeyHash = hashApiKey(newRawKey)
  await supabase.from('agent_api_keys').delete().eq('user_id', userId).eq('label', 'pod')
  await supabase.from('agent_api_keys').insert({ user_id: userId, key_hash: newKeyHash, label: 'pod' })
  await supabase.from('gpu_instances').update({ pod_key_hash: newKeyHash }).eq('user_id', userId)

  // Rebuild the env array from secrets stored on the row.
  const callbackUrl = process.env.SLIMCAST_AGENT_CALLBACK_URL ?? 'https://slimcast-oxlynum.vercel.app'
  const imageTag = process.env.SLIMCAST_RELAY_IMAGE || 'ghcr.io/oxlynum/multistream-relay:latest'
  const lat = instance.provision_lat ?? 39.0
  const lon = instance.provision_lon ?? -95.0

  // Fetch profile for cost ceiling (needed to set SLIMCAST_COST_CEILING_USD).
  const { data: profile } = await supabase
    .from('profiles')
    .select('has_2k_addon, landscape_bitrate_kbps, portrait_bitrate_kbps, output_settings')
    .eq('id', userId)
    .single()

  const has2kAddon = (profile as { has_2k_addon?: boolean } | null)?.has_2k_addon ?? false
  const costCeilingUsd = has2kAddon ? 1.5 : 1.0
  const outputSettings = ((profile as { output_settings?: Record<string, { resolution?: string }> } | null)?.output_settings) ?? {}
  const maxResLabel = Object.values(outputSettings)
    .map(s => s?.resolution)
    .reduce<string>((best, r) => {
      const rank = (x?: string) => (x === '1440p' ? 3 : x === '1080p' ? 2 : x === '720p' ? 1 : 0)
      return rank(r) > rank(best) ? (r as string) : best
    }, '1080p')
  const [srcW, srcH] = has2kAddon && maxResLabel === '1440p' ? [2560, 1440] : maxResLabel === '720p' ? [1280, 720] : [1920, 1080]

  const podEnv = [
    { key: 'SLIMCAST_API_KEY',          value: newRawKey },
    { key: 'SLIMCAST_VERCEL_URL',       value: callbackUrl },
    { key: 'SLIMCAST_INGEST_KEY',       value: instance.ingest_key ?? '' },
    { key: 'SLIMCAST_SRT_PASSPHRASE',   value: instance.srt_passphrase ?? '' },
    { key: 'RELAY_PASSWORD',            value: instance.panel_password ?? '' },
    { key: 'SLIMCAST_COST_CEILING_USD', value: String(costCeilingUsd) },
    { key: 'SOURCE_WIDTH',              value: String(srcW) },
    { key: 'SOURCE_HEIGHT',             value: String(srcH) },
  ]

  // Skip candidates used in prior rounds (each round uses the next N in the ranked list).
  const skipN = (currentRound + 1) * 2  // 2 racers per round

  const raceResult = await startProvisionRace({
    lat, lon,
    name: `slimcast-${userId.slice(0, 8)}`,
    imageTag,
    env: podEnv,
    racersN: 2,
    skipN,
    onRacerCreated: async (racer: RacerEntry) => {
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
    },
  })

  if (!raceResult.started) {
    console.error(`[agent/failed] round ${currentRound + 1} found no candidates for user=${userId}: ${raceResult.error}`)
    await supabase.from('gpu_instances').update({ phase: 'ended', status: 'error' }).eq('user_id', userId)
  } else {
    console.log(`[agent/failed] round ${currentRound + 1} kicked ${raceResult.racerCount} racer(s) for user=${userId}`)
  }

  return Response.json({ ack: true })
}
