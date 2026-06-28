import { createServerClient } from '@/lib/supabase'
import { getProvider, getVpsProvider } from '@/lib/providers'
import type { RacerEntry } from '@/lib/gpu-broker'

// The single, idempotent way to destroy a user's SESSION. Used by manual stop
// (DELETE /api/gpu), the heartbeat self-destruct, the agent terminate request,
// and the cron reaper. A provider error must never strand the DB row or the
// pod key — every path here is best-effort and always cleans up bookkeeping.
//
// VPS-as-the-Hub (Clock A): a session attached to a SHARED hub (vps_hub_id set) is
// torn down LOGICALLY — decrement the hub's refcount (detach_from_hub) and drop the
// session row, but NEVER destroy the box (it serves other tenants; the reaper's
// Clock B destroys an idle hub). Only the legacy per-user GPU pod path destroys an
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
    // Clock A: shared-hub tenant — logical detach only. We won the delete above, so
    // this decrement is exactly-once. NEVER destroys the box (reaper Clock B does).
    await supabase.rpc('detach_from_hub', { p_hub_id: instance.vps_hub_id })
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

  // Atomic CLAIM (drain barrier): flip status→'ended' so no new attach can select
  // this hub (attach considers only live|spawning) and concurrent teardowns don't
  // double-run. For scale-to-zero callers (onlyIfEmpty), ALSO require
  // session_count=0 — if a tenant raced in (incrementing to 1) the claim matches 0
  // rows and we abort, so we never destroy a box a tenant just joined. attach's
  // FOR UPDATE SKIP LOCKED + this UPDATE serialize on the row (review #4/#10/#15/#16).
  let claim = supabase.from('vps_hubs').update({ status: 'ended' }).eq('id', hubId).neq('status', 'ended')
  if (opts?.onlyIfEmpty) claim = claim.eq('session_count', 0)
  const { data: hub } = await claim
    .select('provider, provider_id, primary_ip_id, hub_key_hash')
    .maybeSingle()
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

// How long without a heartbeat before a pod is considered dead.
const SWEEP_STALE_S = 150
// Provisioned but never paired within this window → boot failed.
const SWEEP_NEVER_PAIRED_S = 180
const SWEEP_IDLE_GRACE_S = 5 * 60

/**
 * Inline reaper — no cron cost. Called opportunistically on every pod heartbeat
 * and at provision time. Single DB read; teardowns only fire when truly stale.
 * Idempotent: safe to call concurrently from multiple in-flight requests.
 */
export async function sweepStalePods(): Promise<void> {
  const supabase = createServerClient()
  const { data } = await supabase
    .from('gpu_instances')
    .select('user_id, last_seen_at, created_at, idle_since, streaming, vps_hub_id')
    .neq('status', 'stopped')

  const now = Date.now()
  for (const inst of data ?? []) {
    // VPS hub tenants are governed by the hub clocks (Clock A heartbeat / Clock B
    // teardownHub), NOT these per-pod staleness rules — a still-booting hub session
    // is legitimately unpaired. Mirror the cron reaper's guard (review #2/#7).
    if (inst.vps_hub_id) continue
    const lastSeen  = inst.last_seen_at ? new Date(inst.last_seen_at).getTime() : null
    const createdAt = inst.created_at   ? new Date(inst.created_at).getTime()   : now
    const idleSince = inst.idle_since   ? new Date(inst.idle_since).getTime()   : null

    let reason = ''
    if (!lastSeen && (now - createdAt) / 1000 > SWEEP_NEVER_PAIRED_S) {
      reason = 'never_paired'
    } else if (lastSeen && (now - lastSeen) / 1000 > SWEEP_STALE_S) {
      reason = 'stale_heartbeat'
    } else if (!inst.streaming && idleSince && (now - idleSince) / 1000 > SWEEP_IDLE_GRACE_S) {
      reason = 'idle_timeout'
    }

    if (reason) {
      console.log(`[sweep] tearing down stale pod for ${inst.user_id}: ${reason}`)
      await teardownInstance(inst.user_id, `sweep:${reason}`)
    }
  }
}
