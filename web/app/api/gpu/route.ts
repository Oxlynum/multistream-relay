import { createServerClient } from '@/lib/supabase'
import { destroyPod } from '@/lib/runpod'

export async function DELETE(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: instance } = await supabase
    .from('gpu_instances')
    .select('provider_id, pod_key_hash')
    .eq('user_id', user.id)
    .single()

  if (!instance) {
    return Response.json({ error: 'No streaming server found' }, { status: 404 })
  }

  await destroyPod(instance.provider_id)

  // Revoke the pod's ephemeral key so it can no longer authenticate.
  if (instance.pod_key_hash) {
    await supabase
      .from('agent_api_keys')
      .delete()
      .eq('key_hash', instance.pod_key_hash)
  }

  await supabase
    .from('gpu_instances')
    .delete()
    .eq('user_id', user.id)

  return Response.json({ ok: true })
}
