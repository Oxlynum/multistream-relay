import type { NextRequest } from 'next/server'
import { authenticateNode } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { buildVpsConfig, type PlatformRow } from '@/lib/agent-config'
import type { OutputSettingsMap } from '@/lib/billing'

// VPS-as-the-Hub: a multi-tenant hub polls this every ~10s to learn the FULL set of
// tenant streams it serves (the multi-tenant analog of /api/agent/config, which is
// single-user). The hub reconciles its running per-stream pipelines to this set:
// start a pipeline for each ingest_key present, stop any no longer here.
//
// Authenticated by the hub's OWN 'vps' node key (authenticateNode) — NOT a user key.
// This hands MANY tenants' decrypted stream keys to one rented box, so it must never
// be reachable by a user/pod key (landmine #13).
export async function GET(request: NextRequest) {
  const node = await authenticateNode(request)
  if (!node || node.role !== 'vps' || !node.hubId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const supabase = createServerClient()
  const nowIso = new Date().toISOString()

  // Sessions attached to this hub that should be serving.
  const { data: sessions } = await supabase
    .from('gpu_instances')
    .select('id, user_id, ingest_key, srt_passphrase')
    .eq('vps_hub_id', node.hubId)
    .in('status', ['running', 'provisioning'])

  const tenants = (sessions ?? []).filter(s => s.ingest_key)

  // Heartbeat freshness for the reaper's Clock B (a live-but-empty hub differs from
  // a dead one). Always touch it, even with zero tenants.
  const touchHub = supabase.from('vps_hubs').update({ last_seen_at: nowIso }).eq('id', node.hubId)

  if (tenants.length === 0) {
    await touchHub
    // credits_seconds large+positive: billing is deactivated, and the relay
    // self-stops on credits<=0 from this poll — never let that fire.
    return Response.json({ hub_id: node.hubId, credits_seconds: 999999, streams: [] })
  }

  const userIds = tenants.map(t => t.user_id)
  const [{ data: platforms }, { data: profiles }] = await Promise.all([
    supabase
      .from('platform_connections')
      .select('user_id, platform, rtmp_url, stream_key_encrypted, bitrate_kbps, fps, orientation, enabled, twitch_hevc_eligible, twitch_use_passthrough')
      .in('user_id', userIds),
    supabase
      .from('profiles')
      .select('id, portrait_zoom, portrait_pos_x, portrait_pos_y, landscape_bitrate_kbps, portrait_bitrate_kbps, output_settings')
      .in('id', userIds),
  ])

  const platformsByUser = new Map<string, PlatformRow[]>()
  for (const p of platforms ?? []) {
    const arr = platformsByUser.get((p as { user_id: string }).user_id) ?? []
    arr.push(p as unknown as PlatformRow)
    platformsByUser.set((p as { user_id: string }).user_id, arr)
  }
  const profileById = new Map((profiles ?? []).map(pr => [pr.id, pr]))

  const streams = tenants.map(t => {
    const prof = profileById.get(t.user_id)
    const outputSettings: OutputSettingsMap = (prof?.output_settings as OutputSettingsMap) ?? {}
    const outputs = buildVpsConfig(
      platformsByUser.get(t.user_id) ?? [],
      outputSettings,
      { landscape: prof?.landscape_bitrate_kbps ?? 6000, portrait: prof?.portrait_bitrate_kbps ?? 4000 },
    ).filter(o => o.enabled)
    return {
      instance_id: t.id,
      ingest_key: t.ingest_key,
      srt_passphrase: t.srt_passphrase ?? '',
      outputs,
      crop: {
        zoom: prof?.portrait_zoom ?? 1.0,
        pos_x: prof?.portrait_pos_x ?? 0.5,
        pos_y: prof?.portrait_pos_y ?? 0.5,
      },
    }
  })

  await touchHub
  return Response.json({ hub_id: node.hubId, credits_seconds: 999999, streams })
}
