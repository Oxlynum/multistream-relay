import { createServerClient } from '@/lib/supabase'

const PLATFORM_DEFAULTS: Record<string, { rtmp_url: string; max_bitrate: number; orientation: string }> = {
  twitch:   { rtmp_url: 'rtmp://live.twitch.tv/app',        max_bitrate: 8000, orientation: 'landscape' },
  kick:     { rtmp_url: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app', max_bitrate: 8000, orientation: 'landscape' },
  youtube:  { rtmp_url: 'rtmp://a.rtmp.youtube.com/live2',  max_bitrate: 9000, orientation: 'landscape' },
  tiktok:   { rtmp_url: 'rtmp://push.tiktok.com/live',      max_bitrate: 4500, orientation: 'portrait' },}

export async function POST(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  const { platform, stream_key, rtmp_url, bitrate_kbps, fps, orientation } = body as {
    platform: string
    stream_key: string
    rtmp_url?: string
    bitrate_kbps?: number
    fps?: number
    orientation?: string
  }

  const defaults = PLATFORM_DEFAULTS[platform]
  if (!defaults) {
    return Response.json({ error: 'Unknown platform' }, { status: 400 })
  }
  if (!stream_key?.trim()) {
    return Response.json({ error: 'stream_key is required' }, { status: 400 })
  }

  const effectiveBitrate = bitrate_kbps
    ? Math.min(bitrate_kbps, defaults.max_bitrate)
    : defaults.max_bitrate

  const { error } = await supabase.from('platform_connections').upsert({
    user_id: user.id,
    platform,
    rtmp_url: rtmp_url ?? defaults.rtmp_url,
    stream_key_encrypted: stream_key.trim(),
    bitrate_kbps: effectiveBitrate,
    fps: fps ?? 60,
    orientation: orientation ?? defaults.orientation,
    enabled: true,
  }, { onConflict: 'user_id,platform' })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true, platform })
}

export async function GET(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('platform_connections')
    .select('platform, rtmp_url, bitrate_kbps, fps, orientation, enabled, created_at')
    .eq('user_id', user.id)
    .order('platform')

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ platforms: data })
}
