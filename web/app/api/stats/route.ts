import { createServerClient } from '@/lib/supabase'

export async function GET(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const period = url.searchParams.get('period') ?? '30d'

  let since: string | null = null
  if (period === '7d')  since = new Date(Date.now() - 7  * 86400_000).toISOString()
  if (period === '30d') since = new Date(Date.now() - 30 * 86400_000).toISOString()

  let query = supabase
    .from('stream_sessions')
    .select('duration_seconds, credits_deducted, platforms, started_at')
    .eq('user_id', user.id)
    .not('ended_at', 'is', null)

  if (since) query = query.gte('started_at', since)

  const { data: sessions } = await query

  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits_seconds')
    .eq('id', user.id)
    .single()

  const creditBalance = profile?.streaming_credits_seconds ?? 0
  const totalDurationSeconds = sessions?.reduce((s, r) => s + (r.duration_seconds ?? 0), 0) ?? 0
  const totalCreditsUsed = sessions?.reduce((s, r) => s + (r.credits_deducted ?? 0), 0) ?? 0
  const sessionCount = sessions?.length ?? 0

  const platformCounts: Record<string, number> = {}
  for (const row of sessions ?? []) {
    for (const p of row.platforms ?? []) {
      platformCounts[p] = (platformCounts[p] ?? 0) + 1
    }
  }

  const topPlatforms = Object.entries(platformCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([platform, count]) => ({ platform, count }))

  const avgDurationSeconds = sessionCount > 0
    ? Math.round(totalDurationSeconds / sessionCount)
    : 0

  return Response.json({
    period,
    credit_balance_seconds: creditBalance,
    total_duration_seconds: totalDurationSeconds,
    total_credits_used_seconds: totalCreditsUsed,
    session_count: sessionCount,
    avg_duration_seconds: avgDurationSeconds,
    top_platforms: topPlatforms,
  })
}
