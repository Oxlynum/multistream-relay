import type { NextRequest } from 'next/server'
import { authenticateNode, type NodeAuth } from '@/lib/agent-auth'
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
    // getProvider is strict and throws SYNCHRONOUSLY on a blank/unknown provider — which a
    // trailing .catch() would NOT catch, 500-ing this hot CAS route. Wrap the resolve too.
    try {
      getProvider(loser.provider).destroy(loser.provider_id).catch(e =>
        console.warn(`[agent/ready] gpu loser destroy ${loser.provider_id} failed:`, e))
    } catch (e) {
      console.warn(`[agent/ready] gpu loser resolve ${loser.provider} failed:`, e)
    }
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

// Node self-reports readiness. Role-aware dispatch ONLY — there is no per-user pod
// path anymore (the all-in-one OBS→GPU readiness was deleted when the VPS hub became
// the sole user→GPU route): a 'vps' hub key → handleVpsReady (flip the hub live +
// promote its provisioning tenants); a 'gpu' backend key → handleGpuReady (bridge-in
// CAS on the relay_nodes row). Any non-node key falls through to 401.
export async function POST(request: NextRequest) {
  const node = await authenticateNode(request)
  if (node?.role === 'vps' && node.hubId) {
    return handleVpsReady(request, node.hubId)
  }
  if (node?.role === 'gpu' && node.nodeId) {
    return handleGpuReady(request, node)
  }

  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}
