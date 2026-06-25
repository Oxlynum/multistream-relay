import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'

// SRT uplink toggle, shared by the dashboard settings page and the OBS dock
// (both authenticate here, so the two stay in sync). When enabled, the broker
// provisions a UDP-capable host (Vast datacenter) and OBS pushes SRT instead of
// RTMP; bills +0.1 token/hr (see lib/billing.ts). Takes effect on the next stream.

export async function GET(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServerClient()
  const { data: profile } = await supabase
    .from('profiles')
    .select('srt_enabled')
    .eq('id', userId)
    .single()

  return Response.json({ srt_enabled: profile?.srt_enabled ?? false })
}

export async function PATCH(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  if (typeof body.srt_enabled !== 'boolean') {
    return Response.json({ error: 'srt_enabled (boolean) required' }, { status: 400 })
  }

  const supabase = createServerClient()
  const { error } = await supabase
    .from('profiles')
    .update({ srt_enabled: body.srt_enabled })
    .eq('id', userId)
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true, srt_enabled: body.srt_enabled })
}
