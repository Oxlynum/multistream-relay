import type { NextRequest } from 'next/server'
import { authenticateNode, type NodeAuth } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { type RacerEntry } from '@/lib/gpu-broker'
import { getProvider } from '@/lib/providers'
import { teardownHub } from '@/lib/pod-teardown'

// VPS-hub GPU BACKEND failure (role-aware, on the gpu_backend relay_nodes row): a GPU
// racer reports it can't serve (self-test failed / fatal boot). Mark it failed +
// destroy the box; if ALL racers are dead, DEGRADE the node (transcode outputs stop
// delivering; the hub keeps serving passthrough). No direct-to-GPU fallback. (Re-race
// on boot-failure + the mid-stream re-race land in P9.)
async function handleGpuFailed(request: NextRequest, node: NodeAuth): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { reason?: string; provider_id?: string }
  const supabase = createServerClient()

  const { data: nodeRow } = await supabase
    .from('relay_nodes')
    .select('racers, phase')
    .eq('id', node.nodeId!)
    .maybeSingle()
  if (!nodeRow) return Response.json({ ack: true })
  if (nodeRow.phase === 'ready' || nodeRow.phase === 'streaming') return Response.json({ ack: true })

  const racers = (nodeRow.racers ?? []) as RacerEntry[]
  // Resolve THIS racer. The relay reports provider_id from VAST_INSTANCE_ID, which is
  // EMPTY on RunPod — so fall back to the sole 'booting' racer (N=1), the same way
  // handleGpuReady resolves the winner. Without this the failing box is only marked,
  // never destroyed (its real id lives in the racers entry, not the empty body field).
  const thisRacer = (body.provider_id ? racers.find(r => r.provider_id === body.provider_id) : undefined)
    ?? racers.find(r => r.state === 'booting')
  const updated: RacerEntry[] = racers.map(r =>
    (thisRacer && r.provider_id === thisRacer.provider_id) ? { ...r, state: 'failed' as const } : r,
  )
  await supabase.from('relay_nodes').update({ racers: updated }).eq('id', node.nodeId!)

  // Destroy the failing box NOW (route by the racer's own provider) instead of leaving
  // it to the daily reaper — a RunPod box whose process exited still bills until destroyed.
  if (thisRacer?.provider_id) {
    try { await getProvider(thisRacer.provider).destroy(thisRacer.provider_id) }
    catch (e) { console.error(`[agent/failed] gpu destroy ${thisRacer.provider_id} failed:`, e) }
  }

  const allDead = updated.every(r => r.state === 'failed' || r.state === 'loser')
  const hasWinner = updated.some(r => r.state === 'ready')
  if (allDead && !hasWinner) {
    await supabase.from('relay_nodes').update({ phase: 'ended', status: 'error' }).eq('id', node.nodeId!)
    console.warn(`[agent/failed] gpu node ${node.nodeId} all racers dead (${body.reason ?? '?'}) → degraded; passthrough unaffected`)
  }
  return Response.json({ ack: true })
}

// VPS-as-the-Hub: a hub reports a fatal startup error. The box is confirmed dead, so
// tear it down immediately (destroy server + release primary IP + error its tenants)
// rather than waiting for the reaper — Hetzner bills hourly. No GPU race rounds (a
// hub isn't raced). Checked first so a 'vps' key doesn't hit the pod-race path.
async function handleVpsFailed(request: NextRequest, hubId: string): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { reason?: string }
  console.log(`[agent/failed] vps hub ${hubId} fatal: ${body.reason ?? 'unknown'}`)
  await teardownHub(hubId, `agent_failed:${body.reason ?? 'unknown'}`)
  return Response.json({ ack: true })
}

export async function POST(request: NextRequest) {
  // Role-aware: a 'vps' hub key resolves to a hub, not a user — handle first.
  const node = await authenticateNode(request)
  if (node?.role === 'vps' && node.hubId) {
    return handleVpsFailed(request, node.hubId)
  }
  if (node?.role === 'gpu' && node.nodeId) {
    return handleGpuFailed(request, node)
  }

  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}
