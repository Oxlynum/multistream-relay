import type { NextRequest } from 'next/server'
import { authenticateAgent } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { buildAgentOutputs, type PlatformRow } from '@/lib/agent-config'

// GPU agent calls this on boot to register its IP and receive initial config.
export async function POST(request: NextRequest) {
  const userId = await authenticateAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServerClient()

  // Mark the instance as running. We do NOT touch ip_address/ingest_port here:
  // the agent's self-reported (egress) IP is not the RTMP ingest address — that
  // comes from the RunPod port mapping captured at provision time. Overwriting it
  // would point OBS at the wrong host.
  await supabase
    .from('gpu_instances')
    .update({ status: 'running', last_seen_at: new Date().toISOString() })
    .eq('user_id', userId)

  // Return platform config + portrait framing so the agent can start immediately.
  const { data: platforms } = await supabase
    .from('platform_connections')
    .select('platform, rtmp_url, stream_key_encrypted, bitrate_kbps, fps, orientation, enabled')
    .eq('user_id', userId)

  const { data: profile } = await supabase
    .from('profiles')
    .select('portrait_zoom, portrait_pos_x, portrait_pos_y, landscape_bitrate_kbps, portrait_bitrate_kbps')
    .eq('id', userId)
    .single()

  return Response.json({
    ok: true,
    config: {
      outputs: buildAgentOutputs((platforms ?? []) as PlatformRow[], {
        landscape: profile?.landscape_bitrate_kbps ?? 6000,
        portrait: profile?.portrait_bitrate_kbps ?? 4000,
      }),
      crop: {
        zoom: profile?.portrait_zoom ?? 1.0,
        pos_x: profile?.portrait_pos_x ?? 0.5,
        pos_y: profile?.portrait_pos_y ?? 0.5,
      },
    },
  })
}
