import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'

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

  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { platform } = await params
  const body = await request.json().catch(() => ({}))

  const updates: Record<string, unknown> = {}
  if ('enabled' in body) updates.enabled = !!body.enabled
  if ('bitrate_kbps' in body) {
    updates.bitrate_kbps = Math.max(500, Math.min(8000, Math.round(Number(body.bitrate_kbps)) || 0))
  }
  if ('fps' in body) {
    const fps = Math.round(Number(body.fps))
    updates.fps = [30, 60].includes(fps) ? fps : 60
  }
  if ('orientation' in body && (body.orientation === 'landscape' || body.orientation === 'portrait')) {
    updates.orientation = body.orientation
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const { error } = await supabase
    .from('platform_connections')
    .update(updates)
    .eq('user_id', userId)
    .eq('platform', platform)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true })
}
