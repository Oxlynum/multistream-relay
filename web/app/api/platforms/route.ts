import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'
import { encryptSecret } from '@/lib/crypto'
import { checkTwitchHevcEligibility } from '@/lib/twitch-eligibility'

// Twitch + TikTok use RTMPS (port 443) instead of plain RTMP (port 1935).
// RunPod community cloud nodes are on ISP networks that frequently block
// outbound port 1935. Port 443 (TLS) is never blocked. Twitch documents
// rtmps://live.twitch.tv:443/app as the preferred secure ingest.
const PLATFORM_DEFAULTS: Record<string, { rtmp_url: string; max_bitrate: number; orientation: string }> = {
  twitch:   { rtmp_url: 'rtmps://live.twitch.tv:443/app',   max_bitrate: 8000, orientation: 'landscape' },
  kick:     { rtmp_url: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app', max_bitrate: 8000, orientation: 'landscape' },
  youtube:  { rtmp_url: 'rtmp://a.rtmp.youtube.com/live2',  max_bitrate: 9000, orientation: 'landscape' },
  tiktok:   { rtmp_url: 'rtmp://push.tiktok.com/live',      max_bitrate: 4500, orientation: 'portrait' },
}

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
  // Injection guard: the key is concatenated into the pod's FFmpeg `tee` target
  // string. Characters like | [ ] whitespace/backslash could break out and inject
  // an extra destination (stream exfiltration) or a local file sink. Real platform
  // stream keys are URL-safe and never contain these, so reject them outright.
  if (/[|\[\]\\\s]/.test(stream_key)) {
    return Response.json({ error: 'stream_key contains invalid characters' }, { status: 400 })
  }

  const effectiveBitrate = bitrate_kbps
    ? Math.min(bitrate_kbps, defaults.max_bitrate)
    : defaults.max_bitrate

  const { error } = await supabase.from('platform_connections').upsert({
    user_id: user.id,
    platform,
    rtmp_url: rtmp_url ?? defaults.rtmp_url,
    stream_key_encrypted: encryptSecret(stream_key.trim()),
    bitrate_kbps: effectiveBitrate,
    fps: fps ?? 60,
    orientation: orientation ?? defaults.orientation,
    enabled: true,
  }, { onConflict: 'user_id,platform' })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  // For Twitch, detect HEVC / Enhanced-Broadcasting eligibility from the freshly
  // saved key (we have the plaintext here). Drives the eRTMP-vs-transcode routing
  // and whether the dashboard/dock expose passthrough + 2K. Best-effort: a failed
  // probe leaves the safe default (not eligible → H.264 transcode).
  let twitch_hevc_eligible = false
  if (platform === 'twitch') {
    const elig = await checkTwitchHevcEligibility(stream_key.trim())
    twitch_hevc_eligible = elig.hevcEligible
    await supabase
      .from('platform_connections')
      .update({
        twitch_hevc_eligible: elig.hevcEligible,
        twitch_max_height: elig.maxHeight,
        twitch_eligibility_checked_at: elig.checkedAt,
      })
      .eq('user_id', user.id)
      .eq('platform', 'twitch')
  }

  return Response.json({ ok: true, platform, twitch_hevc_eligible })
}

export async function GET(request: Request) {
  const supabase = createServerClient()

  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('platform_connections')
    .select('platform, rtmp_url, bitrate_kbps, fps, orientation, enabled, created_at, twitch_hevc_eligible, twitch_use_passthrough, twitch_max_height, twitch_eligibility_checked_at')
    .eq('user_id', userId)
    .order('platform')

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ platforms: data })
}
