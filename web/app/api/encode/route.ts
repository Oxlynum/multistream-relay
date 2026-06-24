import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'

// Per-encode-group bitrate caps, shared by the dashboard settings page and the
// OBS dock (both authenticate here, so the two stay in sync). The GPU encodes
// once per orientation, so these are group-level, not per-platform.

// Hard rails — the landscape group can run up to Twitch/Kick's 8000 ceiling,
// the portrait group up to TikTok's 4500.
const LANDSCAPE_MIN = 2500, LANDSCAPE_MAX = 8000
const PORTRAIT_MIN  = 1000, PORTRAIT_MAX  = 4500

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export async function GET(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServerClient()
  const { data: profile } = await supabase
    .from('profiles')
    .select('landscape_bitrate_kbps, portrait_bitrate_kbps, enhanced_twitch')
    .eq('id', userId)
    .single()

  return Response.json({
    landscape_bitrate_kbps: profile?.landscape_bitrate_kbps ?? 6000,
    portrait_bitrate_kbps: profile?.portrait_bitrate_kbps ?? 4000,
    enhanced_twitch: profile?.enhanced_twitch ?? false,
    limits: {
      landscape: { min: LANDSCAPE_MIN, max: LANDSCAPE_MAX },
      portrait: { min: PORTRAIT_MIN, max: PORTRAIT_MAX },
    },
  })
}

export async function PATCH(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const updates: Record<string, number | boolean> = {}

  if ('landscape_bitrate_kbps' in body) {
    updates.landscape_bitrate_kbps = clamp(Number(body.landscape_bitrate_kbps), LANDSCAPE_MIN, LANDSCAPE_MAX)
  }
  if ('portrait_bitrate_kbps' in body) {
    updates.portrait_bitrate_kbps = clamp(Number(body.portrait_bitrate_kbps), PORTRAIT_MIN, PORTRAIT_MAX)
  }
  if ('enhanced_twitch' in body) {
    updates.enhanced_twitch = Boolean(body.enhanced_twitch)
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const supabase = createServerClient()
  const { error } = await supabase.from('profiles').update(updates).eq('id', userId)
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true, ...updates })
}
