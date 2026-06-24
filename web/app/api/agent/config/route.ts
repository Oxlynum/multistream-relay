import type { NextRequest } from 'next/server'
import { authenticateAgent } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { buildAgentOutputs, type PlatformRow } from '@/lib/agent-config'

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
    .select('streaming_credits_seconds, portrait_zoom, portrait_pos_x, portrait_pos_y, landscape_bitrate_kbps, portrait_bitrate_kbps')
    .eq('id', userId)
    .single()

  return Response.json({
    outputs: buildAgentOutputs((platforms ?? []) as PlatformRow[], {
      landscape: profile?.landscape_bitrate_kbps ?? 6000,
      portrait: profile?.portrait_bitrate_kbps ?? 4000,
    }),
    crop: {
      zoom: profile?.portrait_zoom ?? 1.0,
      pos_x: profile?.portrait_pos_x ?? 0.5,
      pos_y: profile?.portrait_pos_y ?? 0.5,
    },
    credits_seconds: profile?.streaming_credits_seconds ?? 0,
  })
}
