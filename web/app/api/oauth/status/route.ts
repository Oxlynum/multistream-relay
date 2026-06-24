import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'

export async function GET(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('platform_tokens')
    .select('platform, connected_at')
    .eq('user_id', userId)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  // Return a map of platform → connected_at for quick lookup
  const connected: Record<string, string> = {}
  for (const row of data ?? []) {
    connected[row.platform] = row.connected_at
  }

  return Response.json({ connected })
}
