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

  const { data: instance } = await supabase
    .from('gpu_instances')
    .select('provider_id, pod_key_hash, provider, session_id, racers, vps_hub_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (!instance) return false

  // Close any session still open on this pod.
  if (instance.session_id) {
    await supabase
      .from('stream_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', instance.session_id)
      .is('ended_at', null)
  }

  if (instance.vps_hub_id) {
    // Clock A: shared-hub tenant — logical detach only. Decrement the refcount so
    // scale-to-zero can eventually fire; do NOT destroy the box.
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

  await supabase.from('gpu_instances').delete().eq('user_id', userId)

  console.log(`[teardown] destroyed ${instance.vps_hub_id ? 'hub-session' : 'pod'} for ${userId}: ${reason}`)
  return true
}

// Clock B: physically destroy a SHARED VPS hub (the box + its billable primary IP),
// revoke its key, and error-out any tenants still pointed at it. Called by the
// reaper (scale-to-zero / stale / never-paired) and by /api/agent/failed when a hub
// reports a fatal startup error. Idempotent + best-effort.
export async function teardownHub(hubId: string, reason: string): Promise<void> {
  const supabase = createServerClient()

  const { data: hub } = await supabase
    .from('vps_hubs')
    .select('provider, provider_id, primary_ip_id, hub_key_hash')
    .eq('id', hubId)
    .maybeSingle()
  if (!hub) return

  // Any tenants still attached lose their stream with the box → error them + unlink
  // (a restart re-provisions onto a fresh hub).
  await supabase
    .from('gpu_instances')
    .update({ status: 'error', vps_hub_id: null })
    .eq('vps_hub_id', hubId)

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
    .select('user_id, last_seen_at, created_at, idle_since, streaming')
    .neq('status', 'stopped')

  const now = Date.now()
  for (const inst of data ?? []) {
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
