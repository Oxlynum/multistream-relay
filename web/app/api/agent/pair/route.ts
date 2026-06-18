import type { NextRequest } from 'next/server'
import { authenticateAgent } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'

// GPU agent calls this on boot to register its IP and receive initial config.
export async function POST(request: NextRequest) {
  const userId = await authenticateAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const ip = body.ip_address as string | undefined

  const supabase = createServerClient()

  // Mark the instance as running and record its IP.
  await supabase
    .from('gpu_instances')
    .update({ status: 'running', ip_address: ip ?? null, last_seen_at: new Date().toISOString() })
    .eq('user_id', userId)

  // Return platform config so the agent can start supervisor immediately.
  const { data: platforms } = await supabase
    .from('platform_connections')
    .select('platform, rtmp_url, stream_key_encrypted, bitrate_kbps, fps, orientation, enabled')
    .eq('user_id', userId)

  return Response.json({ ok: true, config: { outputs: buildOutputs(platforms ?? []) } })
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
