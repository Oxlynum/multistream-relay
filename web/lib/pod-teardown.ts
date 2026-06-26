import { createServerClient } from '@/lib/supabase'
import { getProvider } from '@/lib/providers'
import type { RacerEntry } from '@/lib/gpu-broker'

// The single, idempotent way to destroy a user's pod. Used by manual stop
// (DELETE /api/gpu), the heartbeat self-destruct, the agent terminate request,
// and the cron reaper. A provider error must never strand the DB row or the
// pod key — every path here is best-effort and always cleans up bookkeeping.
export async function teardownInstance(userId: string, reason: string): Promise<boolean> {
  const supabase = createServerClient()

  const { data: instance } = await supabase
    .from('gpu_instances')
    .select('provider_id, pod_key_hash, provider, session_id, racers')
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

  // Kill the main pod first.
  try {
    if (instance.provider_id) {
      await getProvider(instance.provider).destroy(instance.provider_id)
    }
  } catch (e) {
    console.error(`[teardown] provider destroy failed for ${userId} (${reason}):`, e)
  }

  // Kill any racer pods that are still alive (v2 race path).
  // The winner's provider_id was promoted to the top-level column and destroyed
  // above; here we destroy any losers/booting racers still tracked in the array.
  const racers = (instance.racers ?? []) as RacerEntry[]
  for (const racer of racers) {
    if (racer.provider_id && racer.provider_id !== instance.provider_id && racer.state !== 'failed') {
      try {
        await getProvider(racer.provider).destroy(racer.provider_id)
      } catch {
        // Best-effort; the reaper backstops any that survive.
      }
    }
  }

  // Revoke the pod's ephemeral key so a zombie container can't re-authenticate.
  if (instance.pod_key_hash) {
    await supabase.from('agent_api_keys').delete().eq('key_hash', instance.pod_key_hash)
  }

  await supabase.from('gpu_instances').delete().eq('user_id', userId)

  console.log(`[teardown] destroyed pod for ${userId}: ${reason}`)
  return true
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
