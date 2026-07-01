import { createServerClient } from '@/lib/supabase'
import { reraceGpuBackend } from '@/lib/vps-broker'
import { ACTIVE_GPU_PROVIDERS, ACTIVE_VPS_PROVIDERS, getProvider } from '@/lib/providers'
import { nodeTokenOfPodName } from '@/lib/managed-identity'
import { captureError, sendAlert } from '@/lib/observability'
import { ORPHAN_RECONCILE_THROTTLE_MS, METRICS_PRUNE_THROTTLE_MS, COST_ALERT_THROTTLE_MS } from '@/lib/datacenters'
import type { RacerEntry } from '@/lib/gpu-broker'

// The ROW-LESS orphan reconcile + racer cleanup + mid-stream GPU re-race, extracted from the
// daily cron reaper (enterprise-audit REL-05). It reconciles provider.listInstances() against
// the known DB rows — the ONLY path that can see a box the DB has no row for (create
// succeeded, then the function died / a CASCADE dropped the row): the heartbeat lease sweep
// can't, because a row-less box has no renew_deadline to read.
//
// It used to run ONLY once a day (Vercel Hobby caps crons at daily), so a leaked box could
// bill up to ~24h. Now the SAME function is ALSO driven off the heartbeat sweep, throttled
// fleet-wide to ORPHAN_RECONCILE_THROTTLE_MS via try_begin_periodic (…000004), so a leak is
// caught within minutes at ~one cross-provider sweep / window regardless of fleet size.
//
// Idempotent + safe to call any time: it only destroys PAST-DEADLINE / genuinely-row-less
// boxes (guarded by the mid-provision node-token + user-prefix shields), so an extra run
// never kills a healthy box.

type ServerClient = ReturnType<typeof createServerClient>

export interface ReconcileResult {
  orphans: string[]
  orphanHubs: string[]
  auxReleased: number
  reapedGpuNodes: { node_id: string; reason: string }[]
  reracedGpuNodes: { node_id: string }[]
}

// No heartbeat for this long → consider a GPU-backend node stale (re-race floor).
const STALE_S = 150
const IDLE_GRACE_S = 5 * 60
// A GPU backend races across multiple providers + can re-race, so its never-paired
// window is wider than a pod's.
const GPU_NODE_NEVER_PAIRED_S = 300

export async function reconcileOrphans(supabase: ServerClient): Promise<ReconcileResult> {
  const now = Date.now()
  const orphans: string[] = []
  const orphanHubs: string[] = []
  let auxReleased = 0
  const reapedGpuNodes: { node_id: string; reason: string }[] = []
  const reracedGpuNodes: { node_id: string }[] = []

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
    console.error('[reconcile] racer cleanup failed:', e)
  }

  // ── Orphan reconcile: destroy any provider instance with no gpu_instances row ──
  // The only path that can see a pod the DB doesn't know about (the classic
  // "created but the row write lost a race / the function died"). Runs across
  // EVERY active provider so a stray rental can't bill forever. Safe against the provisioning window
  // because provision reserves the row BEFORE creating the pod, so a mid-provision
  // instance's user always has a row — matched here by the user-prefix baked into
  // the instance name (`slimcast-<8 chars>`).
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
        console.error(`[reconcile] ${provider.name} listInstances failed:`, e)
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
          console.error(`[reconcile] failed to destroy orphan ${provider.name} instance ${pod.id}:`, e)
        }
      }
    }
  } catch (e) {
    console.error('[reconcile] orphan reconcile failed:', e)
  }

  // (Clock B hub lifecycle — spawn_timeout / stale_hub / scale_to_zero — is
  // handled by sweepExpiredLeases: the hub box lease covers dead/stuck hubs
  // and the spawn-time lease covers spawn_timeout; derived emptiness covers
  // scale-to-zero. No session_count-reading loop remains.)

  // ── VPS orphan reconcile: destroy any hub box with no vps_hubs row ─────────
  // The classic "created but the row write lost a race / the function died" case,
  // now for Hetzner. listInstances is label-filtered (managed-by=slimcast).
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
      try { live = await provider.listInstances() } catch (e) { console.error(`[reconcile] ${provider.name} listInstances failed:`, e); continue }
      for (const box of live) {
        if (knownHubIds.has(box.id)) continue
        if (box.ownerId && knownHubPrefixes.has(box.ownerId)) continue   // mid-spawn, row exists
        try {
          // destroy(id) without primaryIpId → hetzner.destroy() looks it up and
          // releases the IP only if already unassigned (auto_delete handles the rest).
          await provider.destroy(box.id)
          orphanHubs.push(`${provider.name}:${box.id}`)
        } catch (e) {
          console.error(`[reconcile] failed to destroy orphan hub ${provider.name}:${box.id}:`, e)
        }
      }
    }
  } catch (e) {
    console.error('[reconcile] hub orphan reconcile failed:', e)
  }

  // ── Aux-resource sweep: release DETACHED billable resources (Hetzner primary IPs) ──
  // The one billable thing that survives server deletion and has NO DB row + NO server to
  // hang a lease on, so neither the lease sweeper nor the orphan reconcile above can see
  // it. Each VPS provider releases its own managed + unassigned aux resources. A leaked
  // primary IP bills ~€0.50/mo forever without this (it directly closes the catchall gap
  // the old hetzner.ts:238 comment promised but never had).
  try {
    for (const provider of ACTIVE_VPS_PROVIDERS) {
      if (!provider.releaseAux) continue
      try { auxReleased += await provider.releaseAux() }
      catch (e) { console.error(`[reconcile] ${provider.name} releaseAux failed:`, e) }
    }
  } catch (e) {
    console.error('[reconcile] aux-resource sweep failed:', e)
  }

  // ── GPU-backend node sweep + MID-STREAM re-race (VPS-hub bridge) ───────────
  // A gpu_backend relay_nodes row is a per-session GPU box that bridges to the hub.
  // Its FK (instance_id → gpu_instances) is ON DELETE CASCADE, so a fully torn-down
  // session removes the node automatically — what survives here is:
  //   (a) a stale/never-paired GPU whose parent session is NO LONGER live (the
  //       hub died / session stopped) → destroy the box + revoke key + drop the row.
  //   (b) a stale GPU whose parent session is STILL live (the user is streaming on
  //       the hub's passthrough) → the GPU died MID-STREAM → re-race a fresh one.
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
          console.error(`[reconcile] gpu re-race failed for node ${node.id}:`, e)
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
          console.error(`[reconcile] gpu never-paired re-race failed for node ${node.id}:`, e)
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
          console.error(`[reconcile] gpu node sweep failed for ${node.id}:`, e)
        }
      }
    }
  } catch (e) {
    console.error('[reconcile] gpu node sweep failed:', e)
  }

  return { orphans, orphanHubs, auxReleased, reapedGpuNodes, reracedGpuNodes }
}

// Heartbeat-driven, fleet-throttled periodic maintenance (enterprise-audit REL-05 + SCALE-02).
// Called at the tail of a WINNING, non-frozen sweepExpiredLeases() (so it inherits the sweep's
// ~SWEEP_THROTTLE_MS gate before it even probes these longer throttles — the expensive
// cross-provider reconcile costs ~one probe / sweep window fleet-wide, NOT one per beat). Each
// job runs at most once per its own window across the whole fleet via try_begin_periodic.
// NEVER throws (its caller is a post-response after()); every failure is captured, not raised.
export async function maybePeriodicMaintenance(): Promise<void> {
  const supabase = createServerClient()

  // REL-05: the row-less-orphan reconcile (+ racer cleanup + mid-stream GPU re-race). On
  // Hobby this is the ONLY sub-daily path that catches a leaked box (the daily cron is the floor).
  try {
    const { data: won } = await supabase.rpc('try_begin_periodic', {
      p_task: 'orphan_reconcile', p_throttle_ms: ORPHAN_RECONCILE_THROTTLE_MS,
    })
    if (won === true) {
      const r = await reconcileOrphans(supabase)
      const leaks = r.orphans.length + r.orphanHubs.length + r.auxReleased +
        r.reapedGpuNodes.length + r.reracedGpuNodes.length
      if (leaks > 0) console.log('[periodic] orphan reconcile acted:', JSON.stringify(r))
    }
  } catch (e) {
    captureError('periodic.orphan_reconcile', e)
  }

  // SCALE-02: connection_metrics retention prune (delete rows >24h). Keeps the table bounded
  // between daily crons; each prune deletes only the newly-aged tail (BRIN-indexed → cheap).
  try {
    const { data: won } = await supabase.rpc('try_begin_periodic', {
      p_task: 'metrics_prune', p_throttle_ms: METRICS_PRUNE_THROTTLE_MS,
    })
    if (won === true) await supabase.rpc('prune_old_connection_metrics')
  } catch (e) {
    captureError('periodic.metrics_prune', e)
  }

  // COST-02: real-time cost-tripwire alert. The daily reaper digest also scans this, but a
  // runaway box (live cost_usd_hr > ceiling) shouldn't wait up to 24h to surface — scan every
  // ~15min off the heartbeat and alert. ALERT-not-kill: the margin-throttle lever is gone
  // (CLAUDE.md §9a) and tearing down a paying user's LIVE stream to protect OUR margin is too
  // drastic; the operator gets a real-time signal and decides. Inert unless SLIMCAST_ALERT_WEBHOOK
  // is set. Level-triggered (re-alerts each window while a box stays over) — a persistent
  // over-cost box SHOULD keep nagging until fixed.
  try {
    const { data: won } = await supabase.rpc('try_begin_periodic', {
      p_task: 'cost_alert', p_throttle_ms: COST_ALERT_THROTTLE_MS,
    })
    if (won === true) {
      const tripwire = Number(process.env.SLIMCAST_COST_ALERT_USD_HR ?? '2.0')
      const [{ count: gpuOver }, { count: hubOver }] = await Promise.all([
        supabase.from('gpu_instances').select('id', { count: 'exact', head: true })
          .neq('status', 'stopped').gt('cost_usd_hr', tripwire),
        supabase.from('vps_hubs').select('id', { count: 'exact', head: true })
          .neq('status', 'ended').gt('cost_usd_hr', tripwire),
      ])
      const over = (gpuOver ?? 0) + (hubOver ?? 0)
      if (over > 0) await sendAlert('SlimCast cost tripwire (real-time)', {
        boxes_over_cost_usd_hr: over, tripwire_usd_hr: tripwire,
      })
    }
  } catch (e) {
    captureError('periodic.cost_alert', e)
  }
}
