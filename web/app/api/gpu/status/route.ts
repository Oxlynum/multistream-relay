import { createServerClient } from '@/lib/supabase'
import { authenticateAgent } from '@/lib/agent-auth'

// Polled by the OBS plugin (user API key) to check GPU state.
// Also accepts a Supabase session token for the dashboard.
export async function GET(request: Request) {
  const supabase = createServerClient()
  let userId: string | null = null

  // Try agent/dock API key first.
  userId = await authenticateAgent(request)

  // Fall back to Supabase session (dashboard).
  if (!userId) {
    const authHeader = request.headers.get('authorization')
    const token = authHeader?.replace('Bearer ', '')
    if (token) {
      const { data: { user } } = await supabase.auth.getUser(token)
      userId = user?.id ?? null
    }
  }

  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: instance } = await supabase
    .from('gpu_instances')
    .select('status, ip_address, last_seen_at, burn_rate, outputs, streaming')
    .eq('user_id', userId)
    .maybeSingle()

  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits_seconds')
    .eq('id', userId)
    .single()

  if (!instance) {
    return Response.json({
      status: 'stopped',
      ip: null,
      rtmp_url: null,
      credits_seconds: profile?.streaming_credits_seconds ?? 0,
      burn_rate: 0,
      streaming: false,
      outputs: [],
    })
  }

  // Consider the agent stale if it hasn't checked in for 30s.
  const lastSeen = instance.last_seen_at ? new Date(instance.last_seen_at) : null
  const stale = !lastSeen || (Date.now() - lastSeen.getTime() > 30_000)
  const effectiveStatus = instance.status === 'running' && stale ? 'provisioning' : instance.status

  return Response.json({
    status: effectiveStatus,
    ip: instance.ip_address ?? null,
    rtmp_url: instance.ip_address ? `rtmp://${instance.ip_address}:1935/live` : null,
    credits_seconds: profile?.streaming_credits_seconds ?? 0,
    // Zero the meter when the agent is stale/stopped so the UI doesn't show a
    // burn rate for a stream that isn't actually running.
    burn_rate: effectiveStatus === 'running' ? (instance.burn_rate ?? 0) : 0,
    // Per-platform live state for status dots. Stale/stopped pods aren't live.
    streaming: effectiveStatus === 'running' ? (instance.streaming ?? false) : false,
    outputs: effectiveStatus === 'running' ? (instance.outputs ?? []) : [],
  })
}
