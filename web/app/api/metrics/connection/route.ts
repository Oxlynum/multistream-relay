import type { NextRequest } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'

export async function GET(request: NextRequest) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const direction = searchParams.get('direction') ?? 'inbound'
  const platform = searchParams.get('platform') ?? null
  const windowMinutes = Math.min(parseInt(searchParams.get('window') ?? '60', 10), 120)

  const supabase = createServerClient()

  let query = supabase
    .from('connection_metrics')
    .select('recorded_at, bitrate_kbps, health_score, dropped_frames')
    .eq('user_id', userId)
    .eq('direction', direction)
    .gte('recorded_at', new Date(Date.now() - windowMinutes * 60 * 1000).toISOString())
    .order('recorded_at', { ascending: true })
    .limit(720) // max ~2hr at 10s intervals

  if (direction === 'outbound' && platform) {
    query = query.eq('platform', platform)
  }

  const { data, error } = await query

  if (error) {
    return Response.json({ error: 'Query failed' }, { status: 500 })
  }

  return Response.json({ points: data ?? [] })
}
