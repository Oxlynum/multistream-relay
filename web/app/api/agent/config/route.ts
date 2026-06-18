import type { NextRequest } from 'next/server'
import { authenticateAgent } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'

// Agent polls this every 10s to pick up config changes.
export async function GET(request: NextRequest) {
  const userId = await authenticateAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServerClient()

  const { data: platforms } = await supabase
    .from('platform_connections')
    .select('platform, rtmp_url, stream_key_encrypted, bitrate_kbps, fps, orientation, enabled')
    .eq('user_id', userId)

  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits_seconds')
    .eq('id', userId)
    .single()

  return Response.json({
    outputs: buildOutputs(platforms ?? []),
    credits_seconds: profile?.streaming_credits_seconds ?? 0,
  })
}

function buildOutputs(platforms: Record<string, unknown>[]) {
  return platforms.map(p => ({
    name: p.platform,
    url: p.rtmp_url,
    key: p.stream_key_encrypted,
    bitrate_kbps: p.bitrate_kbps ?? defaultBitrate(p.platform as string),
    fps: p.fps ?? 60,
    orientation: p.orientation ?? 'landscape',
    mode: p.platform === 'youtube' ? 'passthrough' : 'transcode',
    enabled: p.enabled,
  }))
}

function defaultBitrate(platform: string): number {
  const defaults: Record<string, number> = {
    twitch: 6000, kick: 6000, youtube: 6000, tiktok: 4000, facebook: 4000,
  }
  return defaults[platform] ?? 6000
}
