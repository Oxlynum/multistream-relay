import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params

  const userId = await authenticateUserOrAgent(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServerClient()

  // Delete OAuth tokens
  await supabase
    .from('platform_tokens')
    .delete()
    .eq('user_id', userId)
    .eq('platform', platform)

  // Delete the platform connection entirely (same as manual disconnect)
  const { error } = await supabase
    .from('platform_connections')
    .delete()
    .eq('user_id', userId)
    .eq('platform', platform)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true })
}
