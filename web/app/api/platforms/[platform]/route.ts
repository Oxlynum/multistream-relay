import { createServerClient } from '@/lib/supabase'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ platform: string }> }
) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { platform } = await params

  const { error } = await supabase
    .from('platform_connections')
    .delete()
    .eq('user_id', user.id)
    .eq('platform', platform)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ platform: string }> }
) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { platform } = await params
  const body = await request.json().catch(() => ({}))

  const allowed = ['enabled', 'bitrate_kbps', 'fps', 'orientation']
  const updates: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const { error } = await supabase
    .from('platform_connections')
    .update(updates)
    .eq('user_id', user.id)
    .eq('platform', platform)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true })
}
