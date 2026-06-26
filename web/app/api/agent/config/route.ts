import type { NextRequest } from 'next/server'
import { authenticateAgent } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { buildAgentOutputs, type PlatformRow } from '@/lib/agent-config'
import type { OutputSettingsMap } from '@/lib/billing'

// Agent polls this every 10s to pick up config changes.
export async function GET(request: NextRequest) {
  const userId = await authenticateAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServerClient()

  const [{ data: platforms }, { data: profile }] = await Promise.all([
    supabase
      .from('platform_connections')
      .select('platform, rtmp_url, stream_key_encrypted, bitrate_kbps, fps, orientation, enabled')
      .eq('user_id', userId),
    supabase
      .from('profiles')
      .select('streaming_credits, portrait_zoom, portrait_pos_x, portrait_pos_y, landscape_bitrate_kbps, portrait_bitrate_kbps, output_settings')
      .eq('id', userId)
      .single(),
  ])

  const outputSettings: OutputSettingsMap = (profile?.output_settings as OutputSettingsMap) ?? {}

  const outputs = buildAgentOutputs(
    (platforms ?? []) as PlatformRow[],
    outputSettings,
    {
      landscape: profile?.landscape_bitrate_kbps ?? 6000,
      portrait: profile?.portrait_bitrate_kbps ?? 4000,
    },
  )

  const enabled = outputs.filter(o => o.enabled)
  console.log(
    `[agent/config] user=${userId.slice(0, 8)} total=${outputs.length} enabled=${enabled.length}`,
    enabled.map(o =>
      `${o.name}(${o.orientation},mode=${o.mode},url=${(o.url ?? '').slice(0, 40)},key=${o.key ? o.key.slice(0, 6) + '…' : 'MISSING'})`
    ).join(' | ')
  )

  return Response.json({
    outputs,
    crop: {
      zoom: profile?.portrait_zoom ?? 1.0,
      pos_x: profile?.portrait_pos_x ?? 0.5,
      pos_y: profile?.portrait_pos_y ?? 0.5,
    },
    credits: parseFloat(profile?.streaming_credits ?? '0') || 0,
    credits_seconds: Math.round((parseFloat(profile?.streaming_credits ?? '0') || 0) * 3600),
  })
}
