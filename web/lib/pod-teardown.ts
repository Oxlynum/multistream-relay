import { createServerClient } from '@/lib/supabase'
import { getProvider, getVpsProvider } from '@/lib/providers'
import { HUB_IDLE_GRACE_MS, MAX_SESSION_GRACE_S } from '@/lib/datacenters'
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
export async function teardownInstance(userId: string, reason: string): Promise<boolean> {
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
  const { data: instance } = await supabase
    .from('gpu_instances')
    .delete()
    .eq('user_id', userId)
    .select('provider_id, pod_key_hash, provider, session_id, racers, vps_hub_id')
    .maybeSingle()

  if (!instance) return false   // already torn down by a concurrent caller

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
export async function teardownHub(hubId: string, reason: string, opts?: { onlyIfEmpty?: boolean }): Promise<void> {
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
 * The ONE universal, provider-blind lease sweeper (termination-system-plan §9.4).
 * Replaces the old pod-only sweepStalePods. Covers ALL THREE billable kinds via a
 * single time-gate model — no `vps_hub_id` skip, no per-role staleness constants,
 * no daily-cron dependency.
 *
 * Heartbeat-driven: every live relay's status POST fires this (pod, hub AND gpu
 * roles), so any one live box drives reaping of the dead ones within ~1 beat. It
 * reuses the idempotent teardownInstance / teardownHub, so concurrent invocations
 * are safe (the DELETE/claim is the gate). The daily cron keeps calling it too, as
 * the all-idle floor (nothing live to drive the sweep).
 *
 * The lease itself is what tolerates reconnection: a box lease rides the
 * datacenter→Vercel link (user jitter can't trip it), and a tenant reconnect lease
 * is renewed by OBS-source-present — so this sweeper never false-kills a healthy
 * stream the way the old single 150s threshold (doubling as reconnect-tolerance AND
 * orphan-reaping) could.
 */
export async function sweepExpiredLeases(): Promise<void> {
  const supabase = createServerClient()
  const now = Date.now()

  // ── 1. gpu_instances — legacy pods (box lease) AND hub tenants (reconnect lease).
  // No vps_hub_id skip: a hub tenant whose OBS source has been absent past its
  // reconnect lease is reaped here (logical detach + its GPU backend), and the
  // derived hub-emptiness picks up the drop automatically on the next reconcile.
  const { data: insts } = await supabase
    .from('gpu_instances')
    .select('user_id, renew_deadline, max_session_at')
    .neq('status', 'stopped')
  for (const i of insts ?? []) {
    const leaseExpired = i.renew_deadline != null && new Date(i.renew_deadline).getTime() < now
    const capExpired = i.max_session_at != null &&
      new Date(i.max_session_at).getTime() + MAX_SESSION_GRACE_S * 1000 < now
    if (leaseExpired || capExpired) {
      console.log(`[sweep] lease expired for ${i.user_id}: ${capExpired ? 'max_session' : 'lease'}`)
      await teardownInstance(i.user_id, `sweep:${capExpired ? 'max_session' : 'lease_expired'}`)
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
    const boxDead = h.renew_deadline != null && new Date(h.renew_deadline).getTime() < now
    if (boxDead) {
      console.log(`[sweep] hub ${hubId} box lease expired — hard destroy`)
      await teardownHub(hubId, 'sweep:box_lease_expired')   // hard — relay heartbeat gone
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
  const { data: nodes } = await supabase
    .from('relay_nodes')
    .select('id, provider, provider_id, racers, node_key_hash, instance_id, renew_deadline')
    .eq('role', 'gpu_backend')
  for (const n of nodes ?? []) {
    const boxDead = n.renew_deadline != null && new Date(n.renew_deadline).getTime() < now
    if (!boxDead) continue
    let parentLive = false
    if (n.instance_id) {
      const { data: parent } = await supabase
        .from('gpu_instances').select('status').eq('id', n.instance_id as string).maybeSingle()
      parentLive = !!parent && parent.status === 'running'
    }
    if (parentLive) continue   // cron floor re-races a live-parent stale node
    try {
      if (n.provider_id) await getProvider(n.provider).destroy(n.provider_id)
      for (const r of (n.racers ?? []) as RacerEntry[]) {
        if (r.provider_id && r.provider_id !== n.provider_id) {
          try { await getProvider(r.provider).destroy(r.provider_id) } catch { /* best effort */ }
        }
      }
      if (n.node_key_hash) await supabase.from('agent_api_keys').delete().eq('key_hash', n.node_key_hash)
      await supabase.from('relay_nodes').delete().eq('id', n.id)
      console.log(`[sweep] gpu backend ${n.id} lease expired (parent gone) — destroyed`)
    } catch (e) {
      console.error(`[sweep] gpu backend destroy failed ${n.id}:`, e)
    }
  }
}
