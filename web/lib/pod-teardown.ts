import { createServerClient } from '@/lib/supabase'
import { getProvider } from '@/lib/providers/runpod'

// The single, idempotent way to destroy a user's pod. Used by manual stop
// (DELETE /api/gpu), the heartbeat self-destruct, the agent terminate request,
// and the cron reaper. A provider error must never strand the DB row or the
// pod key — every path here is best-effort and always cleans up bookkeeping.
export async function teardownInstance(userId: string, reason: string): Promise<boolean> {
  const supabase = createServerClient()

  const { data: instance } = await supabase
    .from('gpu_instances')
    .select('provider_id, pod_key_hash, provider')
    .eq('user_id', userId)
    .maybeSingle()

  if (!instance) return false

  // Kill the actual cloud pod first — this is the part that stops the bleeding.
  try {
    if (instance.provider_id) {
      await getProvider(instance.provider).destroy(instance.provider_id)
    }
  } catch (e) {
    // Log loudly but keep going: a provider hiccup must not leave the row behind
    // (the reaper would otherwise keep trying forever). RunPod also returns an
    // error when the pod is already gone, which is fine.
    console.error(`[teardown] provider destroy failed for ${userId} (${reason}):`, e)
  }

  // Revoke the pod's ephemeral key so a zombie container can't re-authenticate.
  if (instance.pod_key_hash) {
    await supabase.from('agent_api_keys').delete().eq('key_hash', instance.pod_key_hash)
  }

  await supabase.from('gpu_instances').delete().eq('user_id', userId)

  console.log(`[teardown] destroyed pod for ${userId}: ${reason}`)
  return true
}
