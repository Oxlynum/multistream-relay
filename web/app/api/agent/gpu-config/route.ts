import type { NextRequest } from 'next/server'
import { authenticateNode } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { buildGpuConfig, type PlatformRow } from '@/lib/agent-config'
import type { OutputSettingsMap } from '@/lib/billing'

// The GPU's own bridge-in listener port (container-local; the GPU binds tls://:8899).
const BRIDGE_LISTEN_PORT = 8899
// The VPS hub's RTMPS return-ingest port (the GPU pushes its transcoded H.264 here).
const HUB_RETURN_PORT = 1936

// VPS-hub GPU BACKEND config poll (the analog of /api/agent/config / hub-config for
// the GPU). Auth = authenticateNode(role==='gpu') — NEVER authenticateAgent (a gpu key
// has a user_id and would otherwise resolve to the spawner's user). KEY-FREE: returns
// only per-orientation encode specs + the VPS return URLs + the bridge secret. The GPU
// never sees a platform name/url/key.
export async function GET(request: NextRequest) {
  const node = await authenticateNode(request)
  if (!node || node.role !== 'gpu' || !node.instanceId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const supabase = createServerClient()

  const { data: session, error: sessionErr } = await supabase
    .from('gpu_instances')
    .select('user_id, ingest_key, vps_hub_id, bridge_secret')
    .eq('id', node.instanceId)
    .maybeSingle()
  // Fail-STATIC (C2): a DB error must NOT read as "nothing to transcode" — that stops a live
  // transcode on a transient blip. 503 → the agent's _api() returns None → it keeps its
  // current pipeline. A clean null (GPU not yet hub-linked) is a legitimate empty, handled
  // below with a 200.
  if (sessionErr) {
    console.error('[gpu-config] session query failed:', sessionErr.message)
    return Response.json({ error: 'session query failed' }, { status: 503 })
  }
  if (!session?.ingest_key || !session.vps_hub_id) {
    // Not yet linked to a hub (or torn down) → nothing to transcode yet.
    return Response.json({ groups: [], credits_seconds: 999999 })
  }

  const [{ data: hub, error: hubErr }, { data: profile, error: profileErr }, { data: platforms, error: platformsErr }] = await Promise.all([
    supabase.from('vps_hubs').select('ip_address').eq('id', session.vps_hub_id).maybeSingle(),
    supabase
      .from('profiles')
      .select('portrait_zoom, portrait_pos_x, portrait_pos_y, landscape_bitrate_kbps, portrait_bitrate_kbps, output_settings, has_2k_addon')
      .eq('id', session.user_id)
      .maybeSingle(),
    supabase
      .from('platform_connections')
      .select('platform, rtmp_url, stream_key_encrypted, bitrate_kbps, fps, orientation, enabled, twitch_hevc_eligible, twitch_use_passthrough')
      .eq('user_id', session.user_id),
  ])

  // Fail-STATIC (C2): a partial config would build degraded/empty encode groups and stop a
  // live transcode. 503 so the agent keeps its last-known pipeline instead.
  if (hubErr || profileErr || platformsErr) {
    console.error('[gpu-config] config query failed:', hubErr?.message, profileErr?.message, platformsErr?.message)
    return Response.json({ error: 'config query failed' }, { status: 503 })
  }

  const outputSettings: OutputSettingsMap = (profile?.output_settings as OutputSettingsMap) ?? {}
  const groups = buildGpuConfig(
    (platforms ?? []) as PlatformRow[],
    outputSettings,
    { landscape: profile?.landscape_bitrate_kbps ?? 6000, portrait: profile?.portrait_bitrate_kbps ?? 4000 },
  )

  // Source canvas dims (for portrait crop math), mirroring the provision derivation:
  // the user's max output resolution, capped by the 2K add-on.
  const has2k = profile?.has_2k_addon ?? false
  const rank = (x?: string) => (x === '1440p' ? 3 : x === '1080p' ? 2 : x === '720p' ? 1 : 0)
  const maxRes = Object.values(outputSettings)
    .map(s => s?.resolution)
    .reduce<string>((best, r) => (rank(r) > rank(best) ? (r as string) : best), '1080p')
  const [srcW, srcH] = has2k && maxRes === '1440p' ? [2560, 1440] : maxRes === '720p' ? [1280, 720] : [1920, 1080]

  const hubIp = hub?.ip_address ?? null
  const returnBase = hubIp ? `rtmps://${hubIp}:${HUB_RETURN_PORT}/return/${session.ingest_key}` : null

  return Response.json({
    instance_id: node.instanceId,
    bridge_secret: session.bridge_secret ?? null,
    source: { listen_port: BRIDGE_LISTEN_PORT },
    return: returnBase ? { landscape_url: `${returnBase}/landscape`, portrait_url: `${returnBase}/portrait` } : null,
    groups,
    crop: {
      zoom: profile?.portrait_zoom ?? 1.0,
      pos_x: profile?.portrait_pos_x ?? 0.5,
      pos_y: profile?.portrait_pos_y ?? 0.5,
    },
    source_width: srcW,
    source_height: srcH,
    // billing off → never let the relay self-stop on credits<=0.
    credits_seconds: 999999,
  })
}
