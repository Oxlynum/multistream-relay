import type { NextRequest } from 'next/server'
import { authenticateNode, type NodeAuth } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { type RacerEntry } from '@/lib/gpu-broker'
import { getProvider } from '@/lib/providers'
import { teardownHub } from '@/lib/pod-teardown'
import { reraceGpuBackend } from '@/lib/vps-broker'
import { GPU_BOOT_ATTEMPTS } from '@/lib/datacenters'

// VPS-hub GPU BACKEND failure (role-aware, on the gpu_backend relay_nodes row): a GPU
// racer reports it can't serve (self-test failed / fatal boot). Mark it failed +
// destroy the box. If ALL racers are dead, FAST RE-RACE to the next-ranked candidate
// (up to GPU_BOOT_ATTEMPTS total boot attempts) so one bad NVENC host doesn't strand the
// session on passthrough-only until the daily reaper; once that budget is exhausted the
// node DEGRADES (transcode outputs stop; the hub keeps serving passthrough). No
// direct-to-GPU fallback. (The mid-stream re-race — a GPU that dies after pairing —
// still lands via the reaper's reraceGpuBackend call.)
async function handleGpuFailed(request: NextRequest, node: NodeAuth): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { reason?: string; provider_id?: string }
  const supabase = createServerClient()

  const { data: nodeRow } = await supabase
    .from('relay_nodes')
    .select('racers, phase, race_round')
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
    // Fast re-race on boot-failure: a single bad NVENC host (the boot self-test gate
    // firing) must NOT strand the session on passthrough-only until the daily reaper.
    // race_round is 0-based, so round R means R+1 boot attempts have been made. While
    // under GPU_BOOT_ATTEMPTS, re-race immediately to the next-ranked candidate
    // (reraceGpuBackend rotates the gpu key — so a late /failed from the now-destroyed
    // box can't 401-bypass and kill the fresh racer — destroys the dead box, resets the
    // node, bumps race_round, and fans out a fresh N=1 race anchored on the hub region).
    const attemptsSoFar = (nodeRow.race_round ?? 0) + 1
    if (attemptsSoFar < GPU_BOOT_ATTEMPTS) {
      console.warn(`[agent/failed] gpu node ${node.nodeId} boot-failed (${body.reason ?? '?'}) attempt ${attemptsSoFar}/${GPU_BOOT_ATTEMPTS} → re-racing`)
      try {
        const res = await reraceGpuBackend(node.nodeId!, supabase)
        // On no-capacity / error reraceGpuBackend already sets phase='ended' (degrade).
        if (!res.ok) console.warn(`[agent/failed] gpu node ${node.nodeId} re-race failed: ${res.error} → degraded`)
      } catch (e) {
        // Never let a re-race throw leave the node 'racing' forever (no reaper branch
        // would catch it mid-session) — degrade so passthrough keeps serving + the
        // session can be cleanly restarted.
        await supabase.from('relay_nodes').update({ phase: 'ended', status: 'error' }).eq('id', node.nodeId!)
        console.error(`[agent/failed] gpu node ${node.nodeId} re-race threw → degraded:`, e)
      }
    } else {
      // Budget exhausted: DEGRADE (transcode outputs stop; the hub keeps serving
      // passthrough). No direct-to-GPU fallback.
      await supabase.from('relay_nodes').update({ phase: 'ended', status: 'error' }).eq('id', node.nodeId!)
      console.warn(`[agent/failed] gpu node ${node.nodeId} all racers dead after ${attemptsSoFar} attempts (${body.reason ?? '?'}) → degraded; passthrough unaffected`)
    }
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
