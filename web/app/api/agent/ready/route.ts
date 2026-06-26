import type { NextRequest } from 'next/server'
import { authenticateAgent, hashApiKey } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { getProvider } from '@/lib/providers'
import type { RacerEntry } from '@/lib/gpu-broker'

// Pod self-reports that it is healthy and serving.
//
// The pod reads PUBLIC_IPADDR / VAST_UDP_PORT_8890 / VAST_TCP_PORT_1935 from its
// own Vast-injected env and POSTs them here immediately after MediaMTX starts.
// This replaces the cloud polling (waitForIp + probeRtmp + probeUdp) with a
// pod-push model: the pod knows when it's healthy; the cloud doesn't need to guess.
//
// CAS: the first pod to POST ready for this session WINS — its IP/port are saved
// and its SRT URL becomes serveable. All other racers are told to self-destruct.
export async function POST(request: NextRequest) {
  const userId = await authenticateAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const { ip, srt_port, rtmp_port, container_label } = body as {
    ip?: string
    srt_port?: number
    rtmp_port?: number
    container_label?: string
  }

  if (!ip || !srt_port) {
    return Response.json({ error: 'ip and srt_port are required' }, { status: 400 })
  }

  const supabase = createServerClient()

  // Determine this pod's own provider_id so we can promote it to the winner slot
  // and identify which racers are losers. We match on the calling pod's API key
  // hash against the racers array.
  const auth = request.headers.get('authorization') ?? ''
  const rawKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const callerKeyHash = rawKey ? hashApiKey(rawKey) : ''

  // CAS update: set phase='ready' only if not already won.
  // This is the atomic gate — exactly one pod wins; all others see 0 rows updated.
  const { data: won } = await supabase
    .from('gpu_instances')
    .update({
      ip_address: ip,
      srt_port: Number(srt_port),
      ingest_port: rtmp_port ? Number(rtmp_port) : null,
      phase: 'ready',
      status: 'running',
      last_seen_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    // CAS guard: only win if no one has already claimed ready.
    // Covers v1 (phase IS NULL), v2 requested, v2 racing.
    .or('phase.is.null,phase.eq.provisioning,phase.eq.requested,phase.eq.racing')
    .select('id, provider_id, provider, racers, pod_key_hash, ingest_key, srt_passphrase')
    .maybeSingle()

  if (!won) {
    // Someone already won this race slot — tell this pod to clean itself up.
    console.log(`[agent/ready] user=${userId} lost CAS — self-destruct`)
    return Response.json({ winner: false, action: 'self_destruct' })
  }

  // We won. Find THIS pod's provider_id from the racers array (or the existing
  // provider_id if this is a v1 session where the broker already set it).
  const racers = (won.racers ?? []) as RacerEntry[]
  let winnerProviderId = won.provider_id ?? ''
  let winnerProvider = won.provider ?? 'vast'

  // In the v2 race path the top-level provider_id may be '' or point to a prior
  // pod; find this pod by matching its key hash.
  if (callerKeyHash && won.pod_key_hash === callerKeyHash) {
    // The pod that POSTs /ready is THE pod — find its entry in the racers array.
    // Racers are identified by provider_id; without it we match by process of
    // elimination (the pod that just won must be one of the 'booting' entries).
    const booting = racers.filter(r => r.state === 'booting')
    if (booting.length === 1) {
      winnerProviderId = booting[0].provider_id
      winnerProvider = booting[0].provider
    }
  }

  // Also accept an explicit provider_id in the body (set by agent.py from VAST_CONTAINERLABEL).
  const bodyProviderId = (body as { provider_id?: string }).provider_id
  if (bodyProviderId) {
    winnerProviderId = bodyProviderId
    // Find the provider name from the racers array.
    const matchingRacer = racers.find(r => r.provider_id === bodyProviderId)
    if (matchingRacer) winnerProvider = matchingRacer.provider
  }

  // Promote winner + mark losers in the racers array, then update the top-level
  // provider_id so teardown continues to work.
  const updatedRacers: RacerEntry[] = racers.map(r => ({
    ...r,
    state: r.provider_id === winnerProviderId ? 'ready' : 'loser',
  }))

  await supabase.from('gpu_instances').update({
    provider_id: winnerProviderId || won.provider_id,
    provider: winnerProvider,
    racers: updatedRacers,
  }).eq('user_id', userId)

  console.log(`[agent/ready] user=${userId} winner=${winnerProviderId} ip=${ip} srt=${srt_port} losers=${updatedRacers.filter(r => r.state === 'loser').length}`)

  // Destroy all loser pods asynchronously. Fire-and-forget — the reaper backstops
  // any that survive (they're now 'loser' in racers, so teardown will catch them).
  const losers = updatedRacers.filter(r => r.state === 'loser' && r.provider_id)
  for (const loser of losers) {
    getProvider(loser.provider).destroy(loser.provider_id).catch(e =>
      console.warn(`[agent/ready] loser destroy ${loser.provider_id} failed:`, e)
    )
  }

  return Response.json({ winner: true })
}
