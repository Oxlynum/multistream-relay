import { createServerClient } from '@/lib/supabase'

// Called internally (server-to-server) at stream end to deduct used seconds.
// Also closes the stream_session record.
export async function POST(request: Request) {
  const supabase = createServerClient()

  // This route is called by the agent via its Bearer key.
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    // Also accept agent API key auth for flexibility.
    const { authenticateAgent } = await import('@/lib/agent-auth')
    const userId = await authenticateAgent(request)
    if (!userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return deduct(supabase, userId, await request.json().catch(() => ({})))
  }

  const body = await request.json().catch(() => ({}))
  const { user_id, seconds } = body as { user_id?: string; seconds?: number }
  if (!user_id || typeof seconds !== 'number') {
    return Response.json({ error: 'user_id and seconds required' }, { status: 400 })
  }

  return deduct(supabase, user_id, { seconds, session_id: body.session_id })
}

async function deduct(
  supabase: Awaited<ReturnType<typeof import('@/lib/supabase').createServerClient>>,
  userId: string,
  body: { seconds?: number; session_id?: string }
) {
  const { seconds = 0, session_id } = body

  if (seconds <= 0) return Response.json({ ok: true, deducted: 0 })

  // Deduct credits, floor at 0.
  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits_seconds')
    .eq('id', userId)
    .single()

  const current = profile?.streaming_credits_seconds ?? 0
  const newBalance = Math.max(0, current - seconds)

  await supabase
    .from('profiles')
    .update({ streaming_credits_seconds: newBalance })
    .eq('id', userId)

  // Close the stream session if provided.
  if (session_id) {
    await supabase
      .from('stream_sessions')
      .update({
        ended_at: new Date().toISOString(),
        duration_seconds: seconds,
        credits_deducted: Math.min(seconds, current),
      })
      .eq('id', session_id)
      .eq('user_id', userId)
  }

  return Response.json({ ok: true, deducted: Math.min(seconds, current), new_balance: newBalance })
}
