import type { NextRequest } from 'next/server'
import { authenticateNode } from '@/lib/agent-auth'
import { createServerClient } from '@/lib/supabase'
import { buildVpsConfig, buildAgentOutputs, type PlatformRow } from '@/lib/agent-config'
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
  const { data: sessions, error: sessionsErr } = await supabase
    .from('gpu_instances')
    .select('id, user_id, ingest_key, srt_passphrase, needs_transcode, gpu_node_id, bridge_secret')
    .eq('vps_hub_id', node.hubId)
    .in('status', ['running', 'provisioning'])

  // Fail-STATIC (C2): NEVER return 200 + an empty/partial stream list on a DB error. The
  // hub reconciles its live pipelines to whatever this returns, so a 200 with streams:[]
  // reads as "zero tenants" and stop_all()s every live stream on this shared box — one
  // transient query error becomes a fleet-wide outage. A non-200 makes the agent's _api()
  // return None, so it keeps its last-known tenants running and retries next poll.
  if (sessionsErr) {
    console.error('[hub-config] tenant query failed:', sessionsErr.message)
    return Response.json({ error: 'tenant query failed' }, { status: 503 })
  }

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
  const [{ data: platforms, error: platformsErr }, { data: profiles, error: profilesErr }] = await Promise.all([
    supabase
      .from('platform_connections')
      .select('user_id, platform, rtmp_url, stream_key_encrypted, bitrate_kbps, fps, orientation, enabled, twitch_hevc_eligible, twitch_use_passthrough')
      .in('user_id', userIds),
    supabase
      .from('profiles')
      .select('id, portrait_zoom, portrait_pos_x, portrait_pos_y, landscape_bitrate_kbps, portrait_bitrate_kbps, output_settings')
      .in('id', userIds),
  ])

  // Fail-STATIC (C2): a partial config (missing platform keys / profile settings) would
  // hand the hub degraded per-tenant outputs and stop live deliveries. Bail non-200 so the
  // hub keeps its last-known pipelines rather than applying a half-built config.
  if (platformsErr || profilesErr) {
    console.error('[hub-config] platform/profile query failed:', platformsErr?.message, profilesErr?.message)
    return Response.json({ error: 'config query failed' }, { status: 503 })
  }

  const platformsByUser = new Map<string, PlatformRow[]>()
  for (const p of platforms ?? []) {
    const arr = platformsByUser.get((p as { user_id: string }).user_id) ?? []
    arr.push(p as unknown as PlatformRow)
    platformsByUser.set((p as { user_id: string }).user_id, arr)
  }
  const profileById = new Map((profiles ?? []).map(pr => [pr.id, pr]))

  // For transcode tenants, fetch their gpu_backend node so we can hand the VPS the
  // bridge target (only once the GPU is 'ready' — else the VPS has no forward target
  // and just keeps serving passthrough).
  const gpuNodeIds = tenants.map(t => t.gpu_node_id).filter(Boolean) as string[]
  const gpuNodeById = new Map<string, { ip_address: string | null; bridge_in_port: number | null; phase: string | null }>()
  if (gpuNodeIds.length) {
    const { data: gpuNodes, error: gpuNodesErr } = await supabase
      .from('relay_nodes')
      .select('id, ip_address, bridge_in_port, phase')
      .in('id', gpuNodeIds)
    // Fail-STATIC (C2): on error, don't silently drop the bridge target — that would dark
    // every transcode tenant's GPU forward. 503 so the hub keeps its last-known bridge.
    if (gpuNodesErr) {
      console.error('[hub-config] gpu-node query failed:', gpuNodesErr.message)
      return Response.json({ error: 'gpu-node query failed' }, { status: 503 })
    }
    for (const n of gpuNodes ?? []) gpuNodeById.set(n.id as string, n)
  }

  const streams = tenants.map(t => {
    const prof = profileById.get(t.user_id)
    const outputSettings: OutputSettingsMap = (prof?.output_settings as OutputSettingsMap) ?? {}
    const groupCaps = { landscape: prof?.landscape_bitrate_kbps ?? 6000, portrait: prof?.portrait_bitrate_kbps ?? 4000 }
    const platRows = platformsByUser.get(t.user_id) ?? []
    const outputs = buildVpsConfig(platRows, outputSettings, groupCaps).filter(o => o.enabled)

    // Bridge block for a transcode tenant whose GPU backend is ready: tells the VPS
    // where to push the source (source_forward) and how to fan the GPU's H.264 return
    // out to the transcode platforms (return_outputs — DECRYPTED keys live ONLY here,
    // on the trusted VPS, never on the GPU).
    let bridge: unknown = undefined
    const gpuNode = t.gpu_node_id ? gpuNodeById.get(t.gpu_node_id) : undefined
    if (t.needs_transcode && gpuNode && gpuNode.phase === 'ready' && gpuNode.ip_address && gpuNode.bridge_in_port) {
      const transcodeOut = buildAgentOutputs(platRows, outputSettings, groupCaps)
        .filter(o => o.enabled && o.mode === 'transcode')
      const returnOutputs = (['landscape', 'portrait'] as const).map(orientation => ({
        orientation,
        from: `return/${t.ingest_key}/${orientation}`,
        targets: transcodeOut
          .filter(o => (o.orientation === 'portrait' ? 'portrait' : 'landscape') === orientation)
          .map(o => ({ name: o.name, url: o.url, key: o.key })),
      })).filter(g => g.targets.length > 0)
      bridge = {
        source_forward: `tls://${gpuNode.ip_address}:${gpuNode.bridge_in_port}`,
        bridge_secret: t.bridge_secret ?? null,
        return_outputs: returnOutputs,
      }
    }

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
      ...(bridge ? { bridge } : {}),
    }
  })

  await touchHub
  return Response.json({ hub_id: node.hubId, credits_seconds: 999999, streams })
}
