import { createServerClient } from '@/lib/supabase'
import { getProvider } from '@/lib/providers'
import type { RacerEntry } from '@/lib/gpu-broker'

export type GpuReadyResult = 'won' | 'noop'

// Idempotent winner-CAS promotion of a gpu_backend relay_nodes row to phase='ready',
// recording the GPU's self-reported bridge address. SHARED by two callers so they can
// never drift:
//   • POST /api/agent/ready  — the PRIMARY promoter (the GPU reports once at boot).
//   • POST /api/agent/status — a SELF-HEAL: if the /ready POST was dropped at the edge
//     (a Vercel deploy/cold-start blip eats all 5 retries), the GPU would otherwise sit in
//     phase='racing' forever — heartbeating + billing while no reaper catches it and the
//     hub never opens the bridge (hub-config gates source_forward on phase==='ready').
//     The status heartbeat now carries ip+bridge_port and re-attempts this CAS every beat.
//
// The CAS guard (.or phase null/requested/racing) makes a repeat call on an already-ready
// node a no-op (0 rows updated → 'noop'), so /status can call it every beat cheaply.
// Returns 'won' if THIS call performed the promotion, 'noop' if the node was already
// promoted (or its row is gone). /ready treats 'noop' as "lost the CAS → self-destruct";
// /status treats 'noop' as "already ready → nothing to do".
export async function promoteGpuNodeReady(
  nodeId: string,
  opts: { ip: string; bridgePort: number; providerId?: string },
): Promise<GpuReadyResult> {
  const supabase = createServerClient()
  const nowIso = new Date().toISOString()

  // CAS: first caller to flip this node out of a pre-ready phase wins; others see 0 rows.
  const { data: won } = await supabase
    .from('relay_nodes')
    .update({
      ip_address: opts.ip,
      bridge_in_port: Number(opts.bridgePort),
      phase: 'ready',
      status: 'running',
      last_seen_at: nowIso,
    })
    .eq('id', nodeId)
    .or('phase.is.null,phase.eq.requested,phase.eq.racing')
    .select('id, provider, provider_id, racers')
    .maybeSingle()

  if (!won) return 'noop'

  // Resolve THIS box's racer entry. The relay reports provider_id from VAST_INSTANCE_ID,
  // which is EMPTY on non-Vast providers (RunPod) — so we cannot trust the body's
  // provider_id alone. Fall back to the sole 'booting' racer (the backend race is N=1, so
  // there is exactly one): otherwise the real winner matches no racer, gets tagged 'loser',
  // and the loser-destroy loop tears down the box that just won the CAS (landmine #1/#8).
  const racers = (won.racers ?? []) as RacerEntry[]
  let winnerRacer = opts.providerId ? racers.find(r => r.provider_id === opts.providerId) : undefined
  if (!winnerRacer) {
    const booting = racers.filter(r => r.state === 'booting')
    if (booting.length === 1) winnerRacer = booting[0]
  }
  const winnerProviderId = winnerRacer?.provider_id || opts.providerId || won.provider_id || ''
  const winnerProvider = winnerRacer?.provider || won.provider || ''

  const updated: RacerEntry[] = racers.map(r => ({
    ...r, state: r.provider_id === winnerProviderId ? 'ready' : 'loser',
  }))
  // Persist BOTH provider and provider_id. node.provider was inserted as '' (the winner is
  // unknown until now); without writing it here every teardown/reaper destroy site does
  // getProvider('') → THROWS (strict resolver) → the box bills forever (landmine #4). Only
  // write provider when we actually resolved it.
  const patch: Record<string, unknown> = { provider_id: winnerProviderId || won.provider_id, racers: updated }
  if (winnerProvider) patch.provider = winnerProvider
  await supabase.from('relay_nodes').update(patch).eq('id', nodeId)

  for (const loser of updated.filter(r => r.state === 'loser' && r.provider_id)) {
    // getProvider is strict and throws SYNCHRONOUSLY on a blank/unknown provider — which a
    // trailing .catch() would NOT catch, 500-ing this hot route. Wrap the resolve too.
    try {
      getProvider(loser.provider).destroy(loser.provider_id!).catch(e =>
        console.warn(`[gpu-ready] loser destroy ${loser.provider_id} failed:`, e))
    } catch (e) {
      console.warn(`[gpu-ready] loser resolve ${loser.provider} failed:`, e)
    }
  }
  return 'won'
}
