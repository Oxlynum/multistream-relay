import { createServerClient } from '@/lib/supabase'
import { getProvider, getVpsProvider } from '@/lib/providers'
import {
  HUB_IDLE_GRACE_MS, MAX_SESSION_GRACE_S, SWEEP_GRACE_MS, PROVISION_LEASE_MS,
  SWEEP_THROTTLE_MS, CONTROL_PLANE_OUTAGE_MS, REAP_RECOVERY_GRACE_MS,
} from '@/lib/datacenters'
import type { RacerEntry } from '@/lib/gpu-broker'

// The single, idempotent way to destroy a user's SESSION. Used by manual stop
// (DELETE /api/gpu), the heartbeat self-destruct, the agent terminate request,
// and the cron reaper. A provider error must never strand the DB row or the
// pod key — every path here is best-effort and always cleans up bookkeeping.
//
// VPS-as-the-Hub (Clock A): a session attached to a SHARED hub (vps_hub_id set) is
// torn down LOGICALLY — drop the session row but NEVER destroy the box (it serves
// other tenants; the lease sweeper / Clock B destroys an idle hub). There is no
// refcount to decrement: hub occupancy is DERIVED from live leases (the deleted
// row simply stops counting). Only the legacy per-user GPU pod path destroys an
// actual instance here.
// Atomic lease re-validate for sweep callers (a row that changed its lease between the
// sweep's snapshot read and this delete is spared — the delete matches 0 rows):
//   opts.expectLeaseBefore (ISO) — lease-expiry reap: require renew_deadline < x, so a
//     box/tenant that RE-HEARTBEATED past the threshold survives (review #14).
//   opts.expectLeaseNull — never-paired reap: require renew_deadline IS NULL, so a box
//     that stamped its FIRST lease mid-sweep is not false-reaped (hardening-review #3).
// Manual stop / Clock-A-idle / max-session callers omit both (unconditional delete —
// those reaps are not lease-based).
export async function teardownInstance(
  userId: string,
  reason: string,
  opts?: { expectLeaseBefore?: string; expectLeaseNull?: boolean },
): Promise<boolean> {
  const supabase = createServerClient()

  // Capture this session's GPU BACKEND node(s) BEFORE the row-delete below. The
  // relay_nodes FK is instance_id → gpu_instances ON DELETE CASCADE, so deleting
  // the session row drops the relay_nodes rows but NEVER calls provider.destroy()
  // on the rented GPU box → it bills FOREVER (VPS-hub landmine #4). We read the box
  // ids here, then destroy them explicitly after we win the delete. Legacy
  // all-in-one rows have no gpu_backend nodes → this returns [] and is a no-op.
  const { data: gpuNodes } = await supabase
    .from('relay_nodes')
    .select('provider, provider_id, racers, node_key_hash')
    .eq('user_id', userId)
    .eq('role', 'gpu_backend')

  // Atomically CLAIM the teardown by DELETING the session row and reading it back.
  // The delete is the gate: only the caller that actually removed the row proceeds,
  // so the hub refcount decrement below runs EXACTLY ONCE even under concurrent
  // teardown triggers (Clock A / manual stop / agent terminate / reaper). A losing
  // concurrent caller's delete returns no row → bail (idempotent). (review #1/#6/#8)
  let claimQuery = supabase
    .from('gpu_instances')
    .delete()
    .eq('user_id', userId)
  // Atomic lease re-validate for sweep callers: a row whose lease changed after the
  // sweep flagged it (the post-outage heartbeat herd, or a never-paired box's first
  // beat) no longer matches → spared.
  if (opts?.expectLeaseBefore) claimQuery = claimQuery.lt('renew_deadline', opts.expectLeaseBefore)
  else if (opts?.expectLeaseNull) claimQuery = claimQuery.is('renew_deadline', null)
  const { data: instance } = await claimQuery
    .select('provider_id, pod_key_hash, provider, session_id, racers, vps_hub_id')
    .maybeSingle()

  if (!instance) return false   // already torn down, or its lease was renewed mid-sweep

  // Close any session still open on this pod.
  if (instance.session_id) {
    await supabase
      .from('stream_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', instance.session_id)
      .is('ended_at', null)
  }

  if (instance.vps_hub_id) {
    // Clock A: shared-hub tenant — logical teardown only. NEVER destroys the box
    // (the lease sweeper / Clock B does). There is NOTHING to decrement: hub
    // occupancy is DERIVED from live leases, so deleting this row above already
    // dropped it from hub_active_tenant_count(). The old detach_from_hub refcount
    // decrement — and its wedge-on-lost-decrement failure mode — is gone.
  } else {
    // Legacy GPU pod path: destroy the pod + any racers.
    try {
      if (instance.provider_id) {
        await getProvider(instance.provider).destroy(instance.provider_id)
      }
    } catch (e) {
      console.error(`[teardown] provider destroy failed for ${userId} (${reason}):`, e)
    }

    // Kill any racer pods that are still alive (v2 race path). The winner's
    // provider_id was promoted to the top-level column and destroyed above; here we
    // destroy any losers/booting racers still tracked in the array.
    const racers = (instance.racers ?? []) as RacerEntry[]
    for (const racer of racers) {
      if (racer.provider_id && racer.provider_id !== instance.provider_id) {
        try {
          await getProvider(racer.provider).destroy(racer.provider_id)
        } catch {
          // Best-effort; the reaper backstops any that survive.
        }
      }
    }
  }

  // Revoke the pod's ephemeral key so a zombie container can't re-authenticate.
  // (Hub sessions have no pod key — the hub key lives on vps_hubs, untouched here.)
  if (instance.pod_key_hash) {
    await supabase.from('agent_api_keys').delete().eq('key_hash', instance.pod_key_hash)
  }

  // Destroy the GPU BACKEND box(es) captured before the cascade. This runs for BOTH
  // the vps_hub_id transcode tenant (vps_gpu topology) and any legacy row (which has
  // no gpu_backend nodes → gpuNodes is empty → no-op). Without this the FK cascade
  // silently leaks the rented GPU (landmine #4). Best-effort; the reaper backstops.
  for (const node of gpuNodes ?? []) {
    if (node.provider_id) {
      try {
        await getProvider(node.provider).destroy(node.provider_id)
      } catch (e) {
        console.error(`[teardown] gpu backend destroy failed for ${userId} (${reason}):`, e)
      }
    }
    // Destroy any racer boxes still alive (losers/booting racers from the GPU race).
    // The winner was promoted to node.provider_id (destroyed above); skip it here.
    const gpuRacers = (node.racers ?? []) as RacerEntry[]
    for (const racer of gpuRacers) {
      if (racer.provider_id && racer.provider_id !== node.provider_id) {
        try {
          await getProvider(racer.provider).destroy(racer.provider_id)
        } catch {
          // Best-effort; the reaper backstops any that survive.
        }
      }
    }
    // Revoke this node's 'gpu' key so a zombie GPU container can't re-authenticate.
    if (node.node_key_hash) {
      await supabase.from('agent_api_keys').delete().eq('key_hash', node.node_key_hash)
    }
  }

  console.log(`[teardown] destroyed ${instance.vps_hub_id ? 'hub-session' : 'pod'}${(gpuNodes?.length ?? 0) > 0 ? ' + gpu backend' : ''} for ${userId}: ${reason}`)
  return true
}

// Clock B: physically destroy a SHARED VPS hub (the box + its billable primary IP),
// revoke its key, and error-out any tenants still pointed at it. Called by the
// reaper (scale-to-zero / stale / never-paired) and by /api/agent/failed when a hub
// reports a fatal startup error. Idempotent + best-effort.
// opts.requireLeaseExpired: the box-lease HARD-destroy path (sweep:box_lease_expired)
// passes true so the claim RPC re-reads renew_deadline under its row lock and ABORTS if
// the hub recovered after the sweep's snapshot — so a transient hub→Vercel partition
// can't nuke a recovered multi-tenant box and all its tenants (review #9). Fatal-error /
// reclaim callers omit it (unconditional force).
export async function teardownHub(
  hubId: string,
  reason: string,
  opts?: { onlyIfEmpty?: boolean; requireLeaseExpired?: boolean },
): Promise<void> {
  const supabase = createServerClient()

  // Atomic CLAIM (drain barrier) via RPC: flip status→'ended' so no new attach can
  // select this hub (attach considers only live|spawning) and concurrent teardowns
  // don't double-run. For scale-to-zero callers (onlyIfEmpty) the RPC re-checks the
  // DERIVED live-lease tenant count under a FOR UPDATE row lock — it serializes
  // against attach_session_to_hub's own FOR UPDATE on the same row, so a tenant that
  // just attached is committed-and-counted and the claim aborts rather than
  // destroying a box it just joined. (Replaces the old .eq('session_count', 0)
  // barrier — a derived count can't be a single-row column predicate.)
  const { data: claimed } = await supabase.rpc('claim_hub_for_teardown', {
    p_hub_id: hubId,
    p_only_if_empty: !!opts?.onlyIfEmpty,
    p_require_lease_expired: !!opts?.requireLeaseExpired,
  })
  const hub = (claimed as Array<{ provider: string; provider_id: string | null; primary_ip_id: string | null; hub_key_hash: string | null }> | null)?.[0]
  if (!hub) return   // already ended, or (onlyIfEmpty) a tenant raced in — leave it live

  // Capture this hub's transcode tenants' GPU backend nodes BEFORE we unlink them.
  // The unlink below nulls vps_hub_id (no FK cascade — the gpu_instances rows
  // survive), so a hub death would otherwise ORPHAN the rented GPU boxes that bridge
  // to it. We destroy them explicitly here.
  const { data: hubTenants } = await supabase
    .from('gpu_instances')
    .select('id')
    .eq('vps_hub_id', hubId)
  const tenantInstanceIds = (hubTenants ?? []).map(t => t.id as string)

  // Any tenants still attached lose their stream with the box → error them + unlink
  // (a restart re-provisions onto a fresh hub).
  await supabase
    .from('gpu_instances')
    .update({ status: 'error', vps_hub_id: null })
    .eq('vps_hub_id', hubId)

  // Destroy the GPU backend boxes that bridged to this hub (+ racers + revoke keys),
  // then drop their relay_nodes rows so the sweep doesn't re-process them. Best-effort.
  if (tenantInstanceIds.length > 0) {
    const { data: gpuNodes } = await supabase
      .from('relay_nodes')
      .select('id, provider, provider_id, racers, node_key_hash')
      .eq('role', 'gpu_backend')
      .in('instance_id', tenantInstanceIds)
    for (const node of gpuNodes ?? []) {
      if (node.provider_id) {
        try {
          await getProvider(node.provider).destroy(node.provider_id)
        } catch (e) {
          console.error(`[teardownHub] gpu backend destroy failed for hub ${hubId} (${reason}):`, e)
        }
      }
      const gpuRacers = (node.racers ?? []) as RacerEntry[]
      for (const racer of gpuRacers) {
        if (racer.provider_id && racer.provider_id !== node.provider_id) {
          try {
            await getProvider(racer.provider).destroy(racer.provider_id)
          } catch { /* best effort */ }
        }
      }
      if (node.node_key_hash) {
        await supabase.from('agent_api_keys').delete().eq('key_hash', node.node_key_hash)
      }
      await supabase.from('relay_nodes').delete().eq('id', node.id)
    }
  }

  // Destroy the server AND release the primary IPv4 (the ~€0.50/mo leak guard).
  try {
    if (hub.provider_id) {
      await getVpsProvider(hub.provider).destroy(hub.provider_id, { primaryIpId: hub.primary_ip_id })
    }
  } catch (e) {
    console.error(`[teardownHub] destroy ${hubId} failed (${reason}):`, e)
  }

  if (hub.hub_key_hash) {
    await supabase.from('agent_api_keys').delete().eq('key_hash', hub.hub_key_hash)
  }
  await supabase.from('vps_hubs').delete().eq('id', hubId)

  console.log(`[teardownHub] destroyed hub ${hubId}: ${reason}`)
}

/**
 * Shut off EVERY cloud box a user owns and revoke all their agent keys — the pre-delete
 * hook for account deletion (termination-system-plan §10 Phase 2, item 6).
 *
 * Why this MUST run before the row delete: the profiles → gpu_instances → relay_nodes FK
 * chain is ON DELETE CASCADE, so deleting the user's profile (or the auth user) drops the
 * rows WITHOUT ever calling provider.destroy() — every rented GPU/box would leak, billing
 * forever, recoverable only by the daily name-prefix orphan reconcile. Calling this first
 * destroys the boxes while the rows (and their provider_id) still exist.
 *
 * It does NOT destroy a shared VPS hub: a hub has no user_id (it serves many tenants).
 * teardownInstance logically detaches this user's tenancy; the hub scales to zero on its
 * own via the derived-emptiness sweeper once its last live lease drops.
 *
 * Idempotent + best-effort: teardownInstance is itself idempotent, and a provider error
 * never blocks the key revocation (the reaper backstops any box that survives).
 */
export async function teardownAllForUser(userId: string): Promise<void> {
  // Destroys the active session's all-in-one pod OR vps_gpu backend box(es) + revokes the
  // pod/gpu ephemeral keys, and logically detaches a shared-hub tenant.
  try {
    await teardownInstance(userId, 'account_deletion')
  } catch (e) {
    console.error(`[teardownAllForUser] session teardown failed for ${userId}:`, e)
  }
  // Revoke the user's OWN agent keys (user/device/pod/gpu) so nothing they issued can
  // re-authenticate after the account is gone. CRITICALLY excludes label='vps': a SHARED
  // hub's key is filed under whichever tenant spawned it (agent_api_keys.user_id is NOT
  // NULL, a hub has no identity of its own), so a blanket revoke would starve a hub still
  // serving OTHER tenants → its lease lapses → the sweeper hard-destroys it → every other
  // tenant's stream dies. The account-delete route refuses deletion while the user hosts a
  // hub with other live tenants (and a self-hosted/empty hub's key dying is harmless), so
  // by here any 'vps' key the user holds is for a hub with no other tenants.
  const supabase = createServerClient()
  await supabase.from('agent_api_keys').delete().eq('user_id', userId).neq('label', 'vps')
}

/**
 * The ONE universal, provider-blind lease sweeper (termination-system-plan §9.4).
 * Replaces the old pod-only sweepStalePods. Covers ALL THREE billable kinds via a
 * single time-gate model — no `vps_hub_id` skip, no per-role staleness constants,
 * no daily-cron dependency.
 *
 * Heartbeat-driven: every live relay's status POST fires this (pod, hub AND gpu
 * roles), so any one live box drives reaping of the dead ones within ~1 throttle
 * window. It reuses the idempotent teardownInstance / teardownHub, so concurrent
 * invocations are safe (the DELETE/claim is the gate). The daily cron keeps calling
 * it too, as the all-idle floor (nothing live to drive the sweep).
 *
 * THROTTLED + RECOVERY-GATED (enterprise-audit SCALE-01 / CORR-01): try_begin_sweep()
 * is an atomic single-row CAS that (a) lets only ONE beat per SWEEP_THROTTLE_MS window
 * actually run — so this runs ~once / window regardless of fleet size (the old design
 * ran it on EVERY beat from EVERY box → O(N²) DB load), and (b) freezes reaping for one
 * recovery grace after a control-plane outage so a recovering heartbeat herd re-renews
 * its leases before any reap (the old design mass-false-reaped the whole fleet on the
 * first beat after a >210s Vercel blip). The reaping queries are also index-driven
 * (targeted at actionable rows, not a full-fleet scan) using the …000002 lease indexes.
 *
 * The lease itself is what tolerates reconnection: a box lease rides the
 * datacenter→Vercel link (user jitter can't trip it), and a tenant reconnect lease
 * is renewed by OBS-source-present — so this sweeper never false-kills a healthy
 * stream the way the old single 150s threshold (doubling as reconnect-tolerance AND
 * orphan-reaping) could.
 */
// opts.force = a FLOOR caller (the daily cron, provision-time cleanup), NOT a heartbeat.
// Floor callers must never be throttled (the cron is the guaranteed all-idle floor) and must
// never ARM the recovery freeze — an idle fleet has a huge inter-beat gap that is NOT a
// recovering herd, so arming there would freeze the floor's own sweep and leak a dead-but-
// rowed hub until traffic resumes (the orphaned-Hetzner incident class). They DO still
// respect a freeze a real heartbeat just armed, so a floor sweep landing inside a genuine
// control-plane recovery still defers (CORR-01 intact). Heartbeat callers omit force.
export async function sweepExpiredLeases(opts?: { force?: boolean }): Promise<void> {
  const supabase = createServerClient()
  const now = Date.now()

  // ── 0. THROTTLE + RECOVERY GATE (SCALE-01 / CORR-01).
  if (opts?.force) {
    // Floor caller: no throttle, no arming — but respect a heartbeat-armed freeze.
    const { data: frozen } = await supabase.rpc('reap_freeze_active')
    if (frozen === true) {
      console.log('[sweep] active recovery freeze — floor sweep deferring reaps this cycle')
      return
    }
  } else {
    // Heartbeat caller: one atomic CAS decides whether THIS beat runs the sweep and whether
    // reaping is frozen:
    //   - no row / should_sweep=false → another beat owns this throttle window → skip. This
    //     makes sweep frequency ~constant instead of O(fleet) — without it, N concurrent
    //     boxes each fire a full sweep every ~10s (O(N²) DB storm).
    //   - reap_frozen=true → the control plane just recovered from an outage longer than the
    //     box-dead threshold (BOX_LEASE + SWEEP_GRACE ≈ 210s) → skip ALL reaping for one
    //     recovery grace so the re-beating herd renews every lease first (else the first beat
    //     back would mass-false-reap the whole fleet — CORR-01).
    const { data: gate } = await supabase.rpc('try_begin_sweep', {
      p_throttle_ms: SWEEP_THROTTLE_MS,
      p_outage_ms: CONTROL_PLANE_OUTAGE_MS,
      p_recovery_ms: REAP_RECOVERY_GRACE_MS,
    })
    const g = (gate as Array<{ should_sweep: boolean; reap_frozen: boolean }> | null)?.[0]
    if (!g?.should_sweep) return   // throttled out — another beat owns this window
    if (g.reap_frozen) {
      console.log('[sweep] control-plane recovery freeze active — skipping reaps this cycle')
      return
    }
  }

  // ── 1. gpu_instances — legacy pods (box lease) AND hub tenants (reconnect lease).
  // No vps_hub_id skip: a hub tenant whose OBS source has been absent past its
  // reconnect lease is reaped here (logical detach + its GPU backend), and the
  // derived hub-emptiness picks up the drop automatically on the next reconcile.
  // Settle margin: a lease must be expired for an EXTRA SWEEP_GRACE_MS before reaping,
  // so a heartbeat herd recovering from a >120s control-plane outage re-renews before
  // anything is destroyed (review #1). expectLeaseBefore re-validates atomically at the
  // DELETE so a laggard that re-beats mid-sweep is spared.
  const sweepThresholdIso = new Date(now - SWEEP_GRACE_MS).toISOString()
  // Index-driven (SCALE-01): fetch ONLY actionable rows instead of the whole fleet —
  // lease past the settle threshold, OR 12h cap blown, OR never-paired past the boot
  // window. Backed by the …000002 partial index on (renew_deadline) where status<>'stopped'.
  // The per-row branch below re-derives which condition fired (so the teardown reason +
  // atomic re-validate opts stay exactly as before); this only narrows the candidate set.
  const capThresholdIso = new Date(now - MAX_SESSION_GRACE_S * 1000).toISOString()
  const bootThresholdIso = new Date(now - PROVISION_LEASE_MS).toISOString()
  const { data: insts, error: instsErr } = await supabase
    .from('gpu_instances')
    .select('user_id, renew_deadline, max_session_at, created_at')
    .neq('status', 'stopped')
    .or(
      `renew_deadline.lt.${sweepThresholdIso},` +
      `max_session_at.lt.${capThresholdIso},` +
      `and(renew_deadline.is.null,created_at.lt.${bootThresholdIso})`,
    )
  if (instsErr) console.error('[sweep] gpu_instances query failed:', instsErr)
  for (const i of insts ?? []) {
    const leaseExpired = i.renew_deadline != null &&
      new Date(i.renew_deadline).getTime() + SWEEP_GRACE_MS < now
    const capExpired = i.max_session_at != null &&
      new Date(i.max_session_at).getTime() + MAX_SESSION_GRACE_S * 1000 < now
    // Never-paired backstop (review #4/#5): a row that NEVER got a lease stamped (NULL)
    // and is older than the boot window booted a box but never heartbeated → reap it
    // instead of leaking until the 12h max_session cap (the deleted sweepStalePods
    // never_paired path). New rows are stamped at provision/ready, so this is defense.
    const neverPaired = i.renew_deadline == null && i.created_at != null &&
      new Date(i.created_at).getTime() + PROVISION_LEASE_MS < now
    // The 12h hard cap reaps UNCONDITIONALLY — its only reprieve is a confirm-to-extend
    // that bumps max_session_at, never a heartbeat, so re-validating the lease here would
    // be wrong. The never-paired and lease-expiry reaps BOTH atomically re-validate at the
    // DELETE so a row that stamped its first lease (expectLeaseNull) or re-heartbeated past
    // the threshold (expectLeaseBefore) between this snapshot and the claim is spared —
    // the sweeper never destroys a box that recovered mid-sweep (review #1/#3/#14).
    if (capExpired) {
      console.log(`[sweep] max_session for ${i.user_id}`)
      await teardownInstance(i.user_id, 'sweep:max_session')
    } else if (neverPaired) {
      console.log(`[sweep] never_paired for ${i.user_id}`)
      await teardownInstance(i.user_id, 'sweep:never_paired', { expectLeaseNull: true })
    } else if (leaseExpired) {
      console.log(`[sweep] lease expired for ${i.user_id}`)
      await teardownInstance(i.user_id, 'sweep:lease_expired', { expectLeaseBefore: sweepThresholdIso })
    }
  }

  // ── 2. vps_hubs — box lease lapsed (dead agent/box) → HARD destroy (the incident
  // fix: no longer waits for the daily cron). Else reconcile DERIVED emptiness and
  // scale-to-zero an empty hub past the idle grace.
  const { data: hubs } = await supabase
    .from('vps_hubs')
    .select('id, renew_deadline')
    .neq('status', 'ended')
  for (const h of hubs ?? []) {
    const hubId = h.id as string
    const boxDead = h.renew_deadline != null &&
      new Date(h.renew_deadline).getTime() + SWEEP_GRACE_MS < now
    if (boxDead) {
      console.log(`[sweep] hub ${hubId} box lease expired — hard destroy`)
      // requireLeaseExpired: the claim re-checks renew_deadline under its row lock and
      // aborts if the hub recovered after this snapshot — so a transient partition can't
      // nuke a recovered multi-tenant box and all its tenants (review #9).
      await teardownHub(hubId, 'sweep:box_lease_expired', { requireLeaseExpired: true })
      continue
    }
    // Reconcile empty_since from the DERIVED live-lease count (never a stored
    // refcount → the wedged-counter immortal-hub orphan is structurally impossible).
    const { data: rec } = await supabase.rpc('reconcile_hub_emptiness', { p_hub_id: hubId })
    const row = (rec as Array<{ out_active_count: number; out_empty_since: string | null }> | null)?.[0]
    if (row && row.out_active_count === 0 && row.out_empty_since &&
        now - new Date(row.out_empty_since).getTime() > HUB_IDLE_GRACE_MS) {
      console.log(`[sweep] hub ${hubId} empty past grace — scale-to-zero`)
      await teardownHub(hubId, 'sweep:scale_to_zero', { onlyIfEmpty: true })
    }
  }

  // ── 3. relay_nodes(gpu_backend) — box lease lapsed AND parent session gone →
  // destroy. A still-live parent's stale node is left to the cron floor's richer
  // re-race path (geo re-anchor / key rotation), so this sweeper never churns a
  // GPU mid-stream.
  // provider/provider_id/racers/node_key_hash are re-read via the atomic claim-delete's
  // returning clause below (not here) so the destroy acts on the row we actually won.
  // Index-driven (SCALE-01): only nodes past the box-dead settle threshold or never-paired
  // past the boot window, backed by …000002's (renew_deadline) where role='gpu_backend'
  // partial index. error is logged (not swallowed) so a bad filter can never silently
  // turn the sweep into a no-reap.
  const { data: nodes, error: nodesErr } = await supabase
    .from('relay_nodes')
    .select('id, instance_id, renew_deadline, created_at')
    .eq('role', 'gpu_backend')
    .or(
      `renew_deadline.lt.${sweepThresholdIso},` +
      `and(renew_deadline.is.null,created_at.lt.${bootThresholdIso})`,
    )
  if (nodesErr) console.error('[sweep] gpu_backend node query failed:', nodesErr)
  for (const n of nodes ?? []) {
    const boxDead = n.renew_deadline != null &&
      new Date(n.renew_deadline).getTime() + SWEEP_GRACE_MS < now
    // Never-paired backstop: a gpu-backend box that booted but never heartbeated (NULL
    // lease) past the boot window, whose parent is gone, is reaped below too (review #4).
    const neverPaired = n.renew_deadline == null && n.created_at != null &&
      new Date(n.created_at).getTime() + PROVISION_LEASE_MS < now
    if (!boxDead && !neverPaired) continue
    let parentLive = false
    if (n.instance_id) {
      const { data: parent } = await supabase
        .from('gpu_instances').select('status').eq('id', n.instance_id as string).maybeSingle()
      parentLive = !!parent && parent.status === 'running'
    }
    if (parentLive) continue   // cron floor re-races a live-parent stale node
    // Atomic claim-by-delete: re-validate the lease IN the DELETE predicate and only
    // destroy the box if the row is STILL stale (boxDead → renew_deadline < threshold) or
    // STILL never-paired (NULL lease). A node that re-beat — renewing its lease or stamping
    // its first one — between this snapshot and the claim matches 0 rows and is spared, so
    // the sweeper never churns a recovered GPU (mirrors the teardownInstance/gpu_instances
    // atomic re-validate; review #1/#3/#14). A throw after the row-delete leaks the box only
    // to the daily prefix orphan-reconcile — the same trade-off teardownInstance accepts.
    let nodeClaim = supabase.from('relay_nodes').delete().eq('id', n.id)
    nodeClaim = boxDead ? nodeClaim.lt('renew_deadline', sweepThresholdIso) : nodeClaim.is('renew_deadline', null)
    const { data: claimedNode } = await nodeClaim
      .select('provider, provider_id, racers, node_key_hash').maybeSingle()
    if (!claimedNode) continue   // re-beat mid-sweep → spared
    try {
      if (claimedNode.provider_id) await getProvider(claimedNode.provider).destroy(claimedNode.provider_id)
      for (const r of (claimedNode.racers ?? []) as RacerEntry[]) {
        if (r.provider_id && r.provider_id !== claimedNode.provider_id) {
          try { await getProvider(r.provider).destroy(r.provider_id) } catch { /* best effort */ }
        }
      }
      if (claimedNode.node_key_hash) await supabase.from('agent_api_keys').delete().eq('key_hash', claimedNode.node_key_hash)
      console.log(`[sweep] gpu backend ${n.id} ${boxDead ? 'lease expired' : 'never paired'} (parent gone) — destroyed`)
    } catch (e) {
      console.error(`[sweep] gpu backend destroy failed ${n.id}:`, e)
    }
  }

  // ── 4. REL-05 / SCALE-02: heartbeat-driven, fleet-throttled periodic maintenance.
  // Runs the expensive, low-frequency jobs the lease sweep can't cover — the row-less-orphan
  // reconcile (a box whose DB row was lost has no lease to read) and the connection_metrics
  // retention prune. HEARTBEAT PATH ONLY (skipped on the force/cron floor, which runs the
  // reconcile + prune directly — folding it here too would double-run on the cron). Because
  // we only reach here on a WINNING, non-frozen sweep (past the try_begin_sweep gate above),
  // this inherits the ~SWEEP_THROTTLE_MS cadence before it even probes the 15-/30-min periodic
  // throttles — so the cross-provider reconcile costs ~one probe / sweep window fleet-wide,
  // not one per beat. The dynamic import breaks the pod-teardown → orphan-reconcile →
  // vps-broker → pod-teardown module cycle (orphan-reconcile pulls in reraceGpuBackend).
  if (!opts?.force) {
    try {
      const { maybePeriodicMaintenance } = await import('./orphan-reconcile')
      await maybePeriodicMaintenance()
    } catch (e) {
      console.error('[sweep] periodic maintenance error:', e)
    }
  }
}
