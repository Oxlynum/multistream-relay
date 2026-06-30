import { after } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sweepExpiredLeases } from '@/lib/pod-teardown'
import { reraceGpuBackend } from '@/lib/vps-broker'
import { ACTIVE_GPU_PROVIDERS, ACTIVE_VPS_PROVIDERS, getProvider } from '@/lib/providers'
import { nodeTokenOfPodName } from '@/lib/managed-identity'
import { sendAlert, captureError } from '@/lib/observability'
import type { RacerEntry } from '@/lib/gpu-broker'

// The DEMOTED-TO-FLOOR backstop (termination-system-plan §9.4). The primary reaper
// is now the heartbeat-driven sweepExpiredLeases() — fired from every live relay's
// status beat (pod / hub / gpu), it reaps any stale box within ~1 beat with no cron
// dependency. This daily cron remains for two things the lease alone can't cover:
//   1. The ALL-IDLE floor: if NOTHING is heartbeating, nothing drives the sweep —
//      so the cron runs sweepExpiredLeases() itself once a day as the safety net.
//   2. The ROW-LESS orphan reconcile: a box whose DB row was lost (create-then-die,
//      account-deletion CASCADE) has no renew_deadline to read, so the lease can't
//      see it — only provider.listInstances() vs the known rows can. Plus the v2
//      racer cleanup and the live-parent GPU re-race (richer geo-anchor logic).
// Runs daily on Vercel Hobby; safe to call any time (it only reaps PAST-DEADLINE or
// genuinely-row-less boxes, so even an unauthenticated hit can't kill a healthy box).

// No heartbeat for this long → consider a GPU-backend node stale (re-race floor).
const STALE_S = 150
const IDLE_GRACE_S = 5 * 60
// A GPU backend races across multiple providers + can re-race, so its never-paired
// window is wider than a pod's.
const GPU_NODE_NEVER_PAIRED_S = 300

export async function GET(request: Request) {
  // Protect the endpoint. Vercel cron includes `Authorization: Bearer $CRON_SECRET`
  // when CRON_SECRET is set. If unset (local/dev), allow through.
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return new Response('Unauthorized', { status: 401 })
    }
  }

  const supabase = createServerClient()

  // ── Lease pass (the all-idle floor) ──────────────────────────────────────────
  // The single universal sweeper: gpu_instances (pod + hub-tenant leases), vps_hubs
  // (box lease + derived scale-to-zero) and gpu-backend nodes (dead-parent destroy).
  // This supersedes the old per-pod staleness loop AND the Clock B hub lifecycle loop
  // (both of which read the now-removed session_count). Heartbeats drive it in real
  // time; this daily call is purely the backstop for a fully-idle fleet.
  // force:true — the floor must NOT be throttled and must NOT arm the recovery freeze (an
  // idle fleet's huge inter-beat gap is not a recovering herd; arming would freeze this very
  // sweep and leak a dead-but-rowed hub). It still defers if a heartbeat just armed a freeze.
  await sweepExpiredLeases({ force: true })

  const now = Date.now()

  // ── Racer cleanup: destroy loser/failed racers from v2 races ──────────────
  // teardownInstance handles this on user-initiated stops; here we clean up
  // any that survived (e.g. the /ready handler's fire-and-forget failed).
  try {
    const { data: racerRows } = await supabase
      .from('gpu_instances')
      .select('user_id, racers')
      .neq('status', 'stopped')
    for (const row of racerRows ?? []) {
      const racers = (row.racers ?? []) as RacerEntry[]
      for (const racer of racers) {
        if ((racer.state === 'loser' || racer.state === 'failed') && racer.provider_id) {
          try {
            await getProvider(racer.provider).destroy(racer.provider_id)
            // Clear from the array so we don't re-attempt next run.
            const updatedRacers = racers.map(r =>
              r.provider_id === racer.provider_id ? { ...r, provider_id: '' } : r
            )
            await supabase.from('gpu_instances').update({ racers: updatedRacers }).eq('user_id', row.user_id)
          } catch { /* best effort */ }
        }
      }
    }
  } catch (e) {
    console.error('[reaper] racer cleanup failed:', e)
  }

  // ── Orphan reconcile: destroy any provider instance with no gpu_instances row ──
  // The only path that can see a pod the DB doesn't know about (the classic
  // "created but the row write lost a race / the function died"). Runs across
  // EVERY active provider so a stray rental can't bill forever. Safe against the provisioning window
  // because provision reserves the row BEFORE creating the pod, so a mid-provision
  // instance's user always has a row — matched here by the user-prefix baked into
  // the instance name (`slimcast-<8 chars>`).
  const orphans: string[] = []
  try {
    const { data: allRows } = await supabase
      .from('gpu_instances')
      .select('user_id, provider_id, racers')
    // VPS-hub GPU backends live in relay_nodes (not gpu_instances) — include their
    // provider_id + in-flight racer ids so a LIVE GPU racer mid-race is NOT seen as
    // an orphan and destroyed (landmine #5).
    const { data: nodeRows } = await supabase
      .from('relay_nodes')
      .select('id, provider_id, racers')
      .eq('role', 'gpu_backend')
    // Include racer pod IDs (v2 race path) so active racers aren't orphan-destroyed.
    const knownPodIds = new Set([
      ...(allRows ?? []).map(r => r.provider_id).filter(Boolean),
      ...(allRows ?? []).flatMap(r =>
        ((r.racers ?? []) as RacerEntry[])
          .map(racer => racer.provider_id)
          .filter(Boolean)
      ),
      ...(nodeRows ?? []).map(n => n.provider_id).filter(Boolean),
      ...(nodeRows ?? []).flatMap(n =>
        ((n.racers ?? []) as RacerEntry[])
          .map(racer => racer.provider_id)
          .filter(Boolean)
      ),
    ])
    const knownUserPrefixes = new Set((allRows ?? []).map(r => r.user_id?.slice(0, 8)).filter(Boolean))
    // Session-unique node tokens (relay_nodes.id head) for the mid-provision guard. The GPU
    // box name carries `-<nodeId8>`, and the relay_nodes row is created BEFORE the box
    // (vps-broker), so a booting box's token is live here while a LEAKED box (row
    // CASCADE-dropped) has none → it gets reaped instead of shielded forever.
    const knownNodeTokens = new Set(
      (nodeRows ?? []).map(n => (n.id as string | null)?.slice(0, 8)).filter(Boolean)
    )

    // Sweep EVERY GPU provider that can hold a box (Vast + RunPod). Without RunPod here, a
    // row-less RunPod GPU backend orphan (create() succeeded but the racers write lost a
    // race / the function died) is never listed and bills forever (landmine #4/#5).
    // Mirrors the VPS orphan loop's per-provider sweep below.
    const gpuProviders = ACTIVE_GPU_PROVIDERS
    for (const provider of gpuProviders) {
      // listInstances() is already managed-filtered + carries ownerId (lib/managed-identity);
      // the reaper no longer parses box names. A new provider gets the orphan catchall for
      // free as long as it implements listInstances with the managed filter + ownerId.
      let live: Array<{ id: string; name: string; ownerId: string | null }>
      try {
        live = await provider.listInstances()
      } catch (e) {
        console.error(`[reaper] ${provider.name} listInstances failed:`, e)
        continue
      }
      for (const pod of live) {
        if (knownPodIds.has(pod.id)) continue
        // Mid-provision guard, now session-precise. Spare a box only if its node token is
        // still live (its relay_nodes row exists = genuinely booting). A leaked box whose
        // row was CASCADE-dropped has a token that's no longer live → reaped (closes the
        // shielded-forever leak). A legacy single-segment name carries no token → fall back
        // to the userId-prefix guard so a box created by pre-rename code mid-deploy is still
        // spared (deploy-transition safety; no such boxes exist in steady state).
        const token = nodeTokenOfPodName(pod.name)
        if (token) {
          if (knownNodeTokens.has(token)) continue
        } else if (pod.ownerId && knownUserPrefixes.has(pod.ownerId)) {
          continue
        }
        try {
          await provider.destroy(pod.id)
          orphans.push(`${provider.name}:${pod.id}`)
        } catch (e) {
          console.error(`[reaper] failed to destroy orphan ${provider.name} instance ${pod.id}:`, e)
        }
      }
    }
  } catch (e) {
    console.error('[reaper] orphan reconcile failed:', e)
  }

  // (Clock B hub lifecycle — spawn_timeout / stale_hub / scale_to_zero — is now
  // handled by sweepExpiredLeases above: the hub box lease covers dead/stuck hubs
  // and the spawn-time lease covers spawn_timeout; derived emptiness covers
  // scale-to-zero. No session_count-reading loop remains.)

  // ── VPS orphan reconcile: destroy any hub box with no vps_hubs row ─────────
  // The classic "created but the row write lost a race / the function died" case,
  // now for Hetzner. listInstances is label-filtered (managed-by=slimcast).
  const orphanHubs: string[] = []
  try {
    const { data: hubRows } = await supabase.from('vps_hubs').select('id, provider_id')
    const knownHubIds = new Set((hubRows ?? []).map(h => h.provider_id).filter(Boolean))
    // Also guard the spawn→persist window: a freshly-created box is named
    // slimcast-hub-<region>-<hubId8> and its vps_hubs row exists with provider_id
    // still NULL for a moment. Match the hubId8 in the name so we don't kill it
    // (mirrors the GPU knownUserPrefixes guard) (review #14).
    const knownHubPrefixes = new Set((hubRows ?? []).map(h => (h.id as string | null)?.slice(0, 8)).filter(Boolean))
    for (const provider of ACTIVE_VPS_PROVIDERS) {
      // listInstances() is label-filtered (managed-by:slimcast) + carries ownerId; the
      // reaper no longer parses the hub name.
      let live: Array<{ id: string; name: string; ownerId: string | null }>
      try { live = await provider.listInstances() } catch (e) { console.error(`[reaper] ${provider.name} listInstances failed:`, e); continue }
      for (const box of live) {
        if (knownHubIds.has(box.id)) continue
        if (box.ownerId && knownHubPrefixes.has(box.ownerId)) continue   // mid-spawn, row exists
        try {
          // destroy(id) without primaryIpId → hetzner.destroy() looks it up and
          // releases the IP only if already unassigned (auto_delete handles the rest).
          await provider.destroy(box.id)
          orphanHubs.push(`${provider.name}:${box.id}`)
        } catch (e) {
          console.error(`[reaper] failed to destroy orphan hub ${provider.name}:${box.id}:`, e)
        }
      }
    }
  } catch (e) {
    console.error('[reaper] hub orphan reconcile failed:', e)
  }

  // ── Aux-resource sweep: release DETACHED billable resources (Hetzner primary IPs) ──
  // The one billable thing that survives server deletion and has NO DB row + NO server to
  // hang a lease on, so neither the lease sweeper nor the orphan reconcile above can see
  // it. Each VPS provider releases its own managed + unassigned aux resources. A leaked
  // primary IP bills ~€0.50/mo forever without this (it directly closes the catchall gap
  // the old hetzner.ts:238 comment promised but never had).
  let auxReleased = 0
  try {
    for (const provider of ACTIVE_VPS_PROVIDERS) {
      if (!provider.releaseAux) continue
      try { auxReleased += await provider.releaseAux() }
      catch (e) { console.error(`[reaper] ${provider.name} releaseAux failed:`, e) }
    }
  } catch (e) {
    console.error('[reaper] aux-resource sweep failed:', e)
  }

  // ── GPU-backend node sweep + MID-STREAM re-race (VPS-hub bridge) ───────────
  // A gpu_backend relay_nodes row is a per-session GPU box that bridges to the hub.
  // Its FK (instance_id → gpu_instances) is ON DELETE CASCADE, so a fully torn-down
  // session removes the node automatically — what survives here is:
  //   (a) a stale/never-paired GPU whose parent session is NO LONGER live (the
  //       hub died / session stopped) → destroy the box + revoke key + drop the row.
  //   (b) a stale GPU whose parent session is STILL live (the user is streaming on
  //       the hub's passthrough) → the GPU died MID-STREAM → re-race a fresh one.
  const reapedGpuNodes: { node_id: string; reason: string }[] = []
  const reracedGpuNodes: { node_id: string }[] = []
  try {
    const { data: gpuNodes } = await supabase
      .from('relay_nodes')
      .select('id, provider, provider_id, racers, node_key_hash, phase, last_seen_at, created_at, instance_id')
      .eq('role', 'gpu_backend')

    // Resolve each node's parent session (one query) to decide live vs gone.
    const instIds = [...new Set((gpuNodes ?? []).map(n => n.instance_id).filter(Boolean) as string[])]
    const sessionById = new Map<string, { status: string | null; streaming: boolean | null; idle_since: string | null; vps_hub_id: string | null }>()
    if (instIds.length > 0) {
      const { data: sessions } = await supabase
        .from('gpu_instances')
        .select('id, status, streaming, idle_since, vps_hub_id')
        .in('id', instIds)
      for (const s of sessions ?? []) {
        sessionById.set(s.id as string, { status: s.status, streaming: s.streaming, idle_since: s.idle_since, vps_hub_id: s.vps_hub_id })
      }
    }

    // Resolve the parent hubs' freshness (a session is only "live" if its hub is too).
    const hubIds = [...new Set([...sessionById.values()].map(s => s.vps_hub_id).filter(Boolean) as string[])]
    const hubById = new Map<string, { status: string | null; last_seen_at: string | null }>()
    if (hubIds.length > 0) {
      const { data: hubRows } = await supabase
        .from('vps_hubs')
        .select('id, status, last_seen_at')
        .in('id', hubIds)
      for (const h of hubRows ?? []) hubById.set(h.id as string, { status: h.status, last_seen_at: h.last_seen_at })
    }

    for (const node of gpuNodes ?? []) {
      const lastSeen = node.last_seen_at ? new Date(node.last_seen_at).getTime() : null
      const createdAt = node.created_at ? new Date(node.created_at).getTime() : now
      const stale = lastSeen !== null && (now - lastSeen) / 1000 > STALE_S
      const neverPaired = lastSeen === null && (now - createdAt) / 1000 > GPU_NODE_NEVER_PAIRED_S
      if (!stale && !neverPaired) continue   // fresh, or still inside its boot window

      const session = node.instance_id ? sessionById.get(node.instance_id as string) : undefined
      const hub = session?.vps_hub_id ? hubById.get(session.vps_hub_id) : undefined
      const hubFresh = !!hub && hub.status !== 'ended' &&
        !!hub.last_seen_at && (now - new Date(hub.last_seen_at).getTime()) / 1000 <= STALE_S
      const idleSince = session?.idle_since ? new Date(session.idle_since).getTime() : null
      const sessionIdleTimedOut = !!session && !session.streaming && idleSince !== null && (now - idleSince) / 1000 > IDLE_GRACE_S
      const sessionLive = !!session && session.status === 'running' && hubFresh && !sessionIdleTimedOut

      // (b) MID-STREAM GPU death: parent still live + this GPU was up (phase ready/
      // streaming) but went stale → re-pair a fresh GPU. reraceGpuBackend flips the
      // phase to 'racing', so this fires once per death (won't re-trigger next run).
      if (sessionLive && stale && (node.phase === 'ready' || node.phase === 'streaming')) {
        try {
          await reraceGpuBackend(node.id as string, supabase)
          reracedGpuNodes.push({ node_id: node.id as string })
        } catch (e) {
          console.error(`[reaper] gpu re-race failed for node ${node.id}:`, e)
        }
        continue
      }

      // (b2) NEVER-PAIRED while live: the racer was created but never POSTed /ready|
      // /failed (phase still requested/racing, last_seen null) AND the parent is still
      // streaming passthrough. This falls through BOTH (b) [needs stale, i.e. a non-null
      // last_seen] and (a) [needs !sessionLive] — so without this branch the stuck box
      // bills for the whole session. Re-race a fresh GPU (reraceGpuBackend rotates the
      // key so the stuck box can't pair AND destroys it). (landmine #5)
      if (sessionLive && neverPaired && node.phase !== 'ready' && node.phase !== 'streaming') {
        try {
          await reraceGpuBackend(node.id as string, supabase)
          reracedGpuNodes.push({ node_id: node.id as string })
        } catch (e) {
          console.error(`[reaper] gpu never-paired re-race failed for node ${node.id}:`, e)
        }
        continue
      }

      // (a) Parent session gone/stopped → destroy the orphaned GPU box.
      if (!sessionLive) {
        const reason = neverPaired ? 'never_paired' : 'stale_heartbeat'
        try {
          if (node.provider_id) {
            await getProvider(node.provider).destroy(node.provider_id)
          }
          const racers = (node.racers ?? []) as RacerEntry[]
          for (const racer of racers) {
            if (racer.provider_id && racer.provider_id !== node.provider_id) {
              try { await getProvider(racer.provider).destroy(racer.provider_id) } catch { /* best effort */ }
            }
          }
          if (node.node_key_hash) {
            await supabase.from('agent_api_keys').delete().eq('key_hash', node.node_key_hash)
          }
          await supabase.from('relay_nodes').delete().eq('id', node.id)
          reapedGpuNodes.push({ node_id: node.id as string, reason })
        } catch (e) {
          console.error(`[reaper] gpu node sweep failed for ${node.id}:`, e)
        }
      }
    }
  } catch (e) {
    console.error('[reaper] gpu node sweep failed:', e)
  }

  // ── REL-03: consume the reaper's own payload — alert on leaks + cost overruns ──
  // Before this, the reaper RETURNED its findings but nothing read them (no alert, no
  // dashboard). Now a daily digest fires when the reaper actually destroyed orphans/leaked
  // IPs (orphans existing AT ALL means something is leaking — the operator must know) or
  // any live box is burning above the cost tripwire (margin alarm — the user's stated
  // concern). Inert unless SLIMCAST_ALERT_WEBHOOK is set; ≤1 alert per daily run.
  let overCostCount = 0
  try {
    const tripwire = Number(process.env.SLIMCAST_COST_ALERT_USD_HR ?? '2.0')
    const [{ count: gpuOver }, { count: hubOver }] = await Promise.all([
      supabase.from('gpu_instances').select('id', { count: 'exact', head: true })
        .neq('status', 'stopped').gt('cost_usd_hr', tripwire),
      supabase.from('vps_hubs').select('id', { count: 'exact', head: true })
        .neq('status', 'ended').gt('cost_usd_hr', tripwire),
    ])
    overCostCount = (gpuOver ?? 0) + (hubOver ?? 0)
  } catch (e) {
    captureError('reaper.cost_scan', e)
  }

  const leakCount = orphans.length + orphanHubs.length + auxReleased + reapedGpuNodes.length
  if (leakCount > 0 || overCostCount > 0) {
    after(() => sendAlert('SlimCast reaper digest', {
      orphan_gpus_destroyed: orphans.length,
      orphan_hubs_destroyed: orphanHubs.length,
      leaked_ips_released: auxReleased,
      dead_gpu_nodes_reaped: reapedGpuNodes.length,
      gpu_nodes_reraced: reracedGpuNodes.length,
      boxes_over_cost_tripwire: overCostCount,
    }))
  }

  return Response.json({ ok: true, orphans, orphanHubs, auxReleased, reapedGpuNodes, reracedGpuNodes, overCostCount })
}
