import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'

// "Yes, I'm still streaming." Pushes the 12h session deadline out another 12h.
// Callable by the OBS dock (user key) or dashboard (session JWT) — only ever
// affects the caller's own pod.
const EXTEND_MS = 12 * 60 * 60 * 1000

export async function POST(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServerClient()
  const newDeadline = new Date(Date.now() + EXTEND_MS).toISOString()

  const { data, error } = await supabase
    .from('gpu_instances')
    .update({ max_session_at: newDeadline })
    .eq('user_id', userId)
    .eq('status', 'running')
    .select('id')
    .maybeSingle()

  if (error) return Response.json({ error: error.message }, { status: 500 })
  if (!data) return Response.json({ error: 'No running session to extend' }, { status: 404 })

  return Response.json({ ok: true, max_session_at: newDeadline })
}
