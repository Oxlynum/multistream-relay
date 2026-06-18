import { createServerClient } from '@/lib/supabase'
import { createPod } from '@/lib/runpod'
import { generateApiKey, hashApiKey } from '@/lib/agent-auth'

export async function POST(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: existing } = await supabase
    .from('gpu_instances')
    .select('id, status')
    .eq('user_id', user.id)
    .single()

  if (existing?.status === 'running') {
    return Response.json({ error: 'Streaming server is already running' }, { status: 409 })
  }

  // Generate a fresh ephemeral key for the pod — separate from the user's
  // dashboard API key so provisioning doesn't invalidate the OBS plugin setup.
  const podRawKey = generateApiKey()
  const podKeyHash = hashApiKey(podRawKey)

  // Remove any stale pod key for this user before inserting the new one.
  await supabase
    .from('agent_api_keys')
    .delete()
    .eq('user_id', user.id)
    .eq('label', 'pod')

  await supabase.from('agent_api_keys').insert({
    user_id: user.id,
    key_hash: podKeyHash,
    label: 'pod',
  })

  const imageTag = process.env.SLIMCAST_RELAY_IMAGE ?? 'slimcast/relay:latest'

  const { podId } = await createPod({
    name: `slimcast-${user.id.slice(0, 8)}`,
    imageTag,
    apiKey: podRawKey,
  })

  if (existing) {
    await supabase.from('gpu_instances').update({
      provider_id: podId,
      pod_key_hash: podKeyHash,
      status: 'provisioning',
      ip_address: null,
      last_seen_at: null,
    }).eq('user_id', user.id)
  } else {
    await supabase.from('gpu_instances').insert({
      user_id: user.id,
      provider_id: podId,
      pod_key_hash: podKeyHash,
      status: 'provisioning',
    })
  }

  return Response.json({ ok: true })
}
