import { createServerClient } from '@/lib/supabase'
import { getProvider } from '@/lib/providers/runpod'

export async function POST(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: instance } = await supabase
    .from('gpu_instances')
    .select('provider_id, status, provider')
    .eq('user_id', user.id)
    .single()

  if (!instance) {
    return Response.json({ error: 'No streaming server found' }, { status: 404 })
  }

  await getProvider(instance.provider).stop(instance.provider_id)

  await supabase
    .from('gpu_instances')
    .update({ status: 'stopped' })
    .eq('user_id', user.id)

  return Response.json({ ok: true })
}
