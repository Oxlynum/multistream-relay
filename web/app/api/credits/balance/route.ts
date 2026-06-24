import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'

export async function GET(request: Request) {
  const supabase = createServerClient()

  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits')
    .eq('id', userId)
    .single()

  const tokens = parseFloat(profile?.streaming_credits ?? '0') || 0
  const seconds = Math.round(tokens * 3600)
  const hours = Math.floor(tokens)
  const minutes = Math.floor((tokens % 1) * 60)

  return Response.json({
    tokens,
    seconds,
    hours,
    minutes,
    formatted: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
    low: tokens < 0.5,  // warn at 30 min (0.5 tokens)
  })
}
