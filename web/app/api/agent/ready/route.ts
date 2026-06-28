import type { NextRequest } from 'next/server'
import { authenticateAgent, authenticateNode, hashApiKey, type NodeAuth } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { getProvider } from '@/lib/providers'
import { PROVISION_LEASE_MS } from '@/lib/datacenters'
import type { RacerEntry } from '@/lib/gpu-broker'

// VPS-hub GPU BACKEND readiness (role-aware): the GPU self-reports its bridge-in
// address. Winner-CAS on the gpu_backend relay_nodes row (NEVER gpu_instances — that
// would clobber the VPS tenant's session). The losing racers self-destruct. Checked
// before the per-user pod path so a 'gpu' key never falls into authenticateAgent.
async function handleGpuReady(request: NextRequest, node: NodeAuth): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { ip?: string; bridge_port?: number; provider_id?: string }
  const { ip, bridge_port, provider_id } = body
  if (!ip || !bridge_port) {
    return Response.json({ error: 'ip and bridge_port are required' }, { status: 400 })
  }
  const supabase = createServerClient()
  const nowIso = new Date().toISOString()

  // CAS: first racer to report ready wins this node; others see 0 rows updated.
  const { data: won } = await supabase
    .from('relay_nodes')
    .update({
      ip_address: ip,
      bridge_in_port: Number(bridge_port),
      phase: 'ready',
      status: 'running',
      last_seen_at: nowIso,
    })
    .eq('id', node.nodeId!)
    .or('phase.is.null,phase.eq.requested,phase.eq.racing')
    .select('id, provider, provider_id, racers')
    .maybeSingle()

  if (!won) {
    console.log(`[agent/ready] gpu node ${node.nodeId} lost CAS — self-destruct`)
    return Response.json({ winner: false, action: 'self_destruct' })
  }

  // Resolve THIS box's racer entry. The relay reports provider_id from VAST_INSTANCE_ID,
  // which is EMPTY on non-Vast providers (RunPod) — so we cannot trust the body's
  // provider_id alone. Fall back to the sole 'booting' racer (the backend race is N=1,
  // so there is exactly one): otherwise the real winner matches no racer, gets tagged
  // 'loser', and the loser-destroy loop tears down the box that just won the CAS
  // (landmine #1/#8). Mirrors the pod /ready path's sole-booting-racer promotion.
  const racers = (won.racers ?? []) as RacerEntry[]
  let winnerRacer = (provider_id ? racers.find(r => r.provider_id === provider_id) : undefined)
  if (!winnerRacer) {
    const booting = racers.filter(r => r.state === 'booting')
    if (booting.length === 1) winnerRacer = booting[0]
  }
  const winnerProviderId = winnerRacer?.provider_id || provider_id || won.provider_id || ''
  const winnerProvider = winnerRacer?.provider || won.provider || ''

  const updated: RacerEntry[] = racers.map(r => ({
    ...r, state: r.provider_id === winnerProviderId ? 'ready' : 'loser',
  }))
  // Persist BOTH provider and provider_id. node.provider was inserted as '' (the
  // winner is unknown until now); without writing it here every teardown/reaper
  // destroy site does getProvider('') → silent Vast fallback → a RunPod winner box
  // bills forever (landmine #4). Only write provider when we actually resolved it.
  const patch: Record<string, unknown> = { provider_id: winnerProviderId || won.provider_id, racers: updated }
  if (winnerProvider) patch.provider = winnerProvider
  await supabase.from('relay_nodes').update(patch).eq('id', node.nodeId!)

  for (const loser of updated.filter(r => r.state === 'loser' && r.provider_id)) {
    getProvider(loser.provider).destroy(loser.provider_id).catch(e =>
      console.warn(`[agent/ready] gpu loser destroy ${loser.provider_id} failed:`, e))
  }
  console.log(`[agent/ready] gpu node ${node.nodeId} winner=${winnerProvider || '?'}:${winnerProviderId} ip=${ip} bridge=${bridge_port}`)
  return Response.json({ winner: true })
}

// VPS-as-the-Hub readiness (role-aware): a hub reports healthy at the BOX level —
// flip vps_hubs to 'live' and promote its attached provisioning tenants to running
// (so /api/gpu/status starts serving each tenant's srt_url). NO per-session CAS, no
// winner/loser (a hub is deterministic, not raced N-wide), and it never touches a
// tenant's session except the provisioning→running promotion. Checked FIRST so a
// 'vps' key (which also carries a user_id in agent_api_keys) never falls into the
// per-user pod CAS path below.
async function handleVpsReady(request: NextRequest, hubId: string): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { ip?: string }
  const supabase = createServerClient()
  const nowIso = new Date().toISOString()

  const hubUpdate: Record<string, unknown> = { status: 'live', last_seen_at: nowIso }
  if (body.ip) hubUpdate.ip_address = body.ip
  await supabase.from('vps_hubs').update(hubUpdate).eq('id', hubId)

  const { data: hub } = await supabase.from('vps_hubs').select('ip_address').eq('id', hubId).maybeSingle()
  const hubIp = body.ip ?? hub?.ip_address ?? null

  // Promote tenants that attached while the hub was spawning. (Attaches to an
  // already-live hub were set 'running' at attach time — this is for the spawner +
  // early joiners.) REFRESH the tenant lease here too: /ready is the PRIMARY promoter
  // (the hub POSTs /ready before its first heartbeat), so without this the spawner's
  // boot lease is never extended once the hub becomes serveable and a slow first OBS
  // connect on a near-timeout boot is reaped ~90s after ready (hardening-review #1 —
  // the handleVpsStatus refresh only catches the rare lost-/ready self-heal path).
  const sessionUpdate: Record<string, unknown> = {
    status: 'running', phase: 'ready', last_seen_at: nowIso,
    renew_deadline: new Date(Date.now() + PROVISION_LEASE_MS).toISOString(),
  }
  if (hubIp) sessionUpdate.ip_address = hubIp
  await supabase.from('gpu_instances').update(sessionUpdate).eq('vps_hub_id', hubId).eq('status', 'provisioning')

  console.log(`[agent/ready] vps hub ${hubId} live ip=${hubIp}`)
  return Response.json({ ok: true })
}

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
  // Role-aware: a 'vps' hub key resolves to a hub (never a single user), so handle
  // it before the per-user pod CAS path.
  const node = await authenticateNode(request)
  if (node?.role === 'vps' && node.hubId) {
    return handleVpsReady(request, node.hubId)
  }
  if (node?.role === 'gpu' && node.nodeId) {
    return handleGpuReady(request, node)
  }

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
      // Refresh the boot lease from the ready moment so a pod that wins /ready then dies
      // before its first /status heartbeat is still swept in ~PROVISION_LEASE_MS, not at
      // the 12h cap (review #4). The 10s heartbeat then renews it to BOX_LEASE_MS.
      renew_deadline: new Date(Date.now() + PROVISION_LEASE_MS).toISOString(),
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
