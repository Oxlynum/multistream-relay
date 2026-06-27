// VPS-as-the-Hub broker (Phase 1, multi-tenant). The control-plane counterpart of
// gpu-broker.ts, but for the SHARED Hetzner hub instead of a per-user GPU pod.
//
// Model: JOIN-OR-SPAWN. A stream attaches to the nearest existing regional hub that
// has spare capacity; only if none does anywhere do we spawn a new box. One box is
// amortized across many tenants (the flat-fee economics), and an empty box is
// destroyed by the reaper (Clock B scale-to-zero) — never by a per-stream stop.
//
// Concurrency: the attach is a Postgres RPC (attach_session_to_hub) doing
// FOR UPDATE SKIP LOCKED, and the spawn is guarded by a partial-unique index on
// vps_hubs(region) WHERE status='spawning' — so two concurrent first-users in an
// empty region can't spawn duplicate boxes (the loser joins the spawning hub).

import { createServerClient } from '@/lib/supabase'
import { generateApiKey, hashApiKey } from '@/lib/agent-auth'
import { getVpsProvider, ACTIVE_VPS_PROVIDERS } from '@/lib/providers'
import { buildCloudInit } from '@/lib/cloud-init'
import { haversineKm } from '@/lib/gpu-broker'
import { VPS_PRICE_CEILING, HUB_MAX_SESSIONS } from '@/lib/datacenters'
import type { VpsCandidate } from '@/lib/providers/types'

type Supa = ReturnType<typeof createServerClient>

// Fixed on Hetzner (container port == host == public, no remap). The relay binds
// SRT on 8890; we publish 8890/udp in the hub's cloud-init.
const HUB_SRT_PORT = 8890

// vps_hubs row shape returned by attach_session_to_hub (the columns we read).
interface HubRow {
  id: string
  status: string
  ip_address: string | null
  srt_passphrase: string | null
  region: string | null
}

export interface AcquireHubArgs {
  userId: string
  lat: number
  lon: number
  imageTag: string
  callbackUrl: string
  supabase: Supa
}

export interface AcquireHubResult {
  ok: boolean
  attached?: boolean              // joined an existing hub (vs spawned a new one)
  hubId?: string
  ip?: string | null
  srtPort?: number
  status?: 'live' | 'spawning'
  region?: string
  error?: string
}

// Parse the existing VAST_IMAGE_LOGIN ("-u USER -p TOKEN SERVER") into the shape
// cloud-init needs, so the hub can pull the private relay image from ghcr.
function parseImageLogin(): { server: string; username: string; password: string } | undefined {
  const raw = process.env.VAST_IMAGE_LOGIN
  if (!raw) return undefined
  const m = raw.match(/-u\s+(\S+)\s+-p\s+(\S+)\s+(\S+)/)
  if (!m) return undefined
  return { username: m[1], password: m[2], server: m[3] }
}

async function rankCandidates(lat: number, lon: number): Promise<VpsCandidate[]> {
  const lists = await Promise.all(
    ACTIVE_VPS_PROVIDERS.map(async p => {
      try { return await p.listCandidates({ maxPricePerHr: VPS_PRICE_CEILING }) }
      catch (e) { console.error(`[vps-broker] ${p.name} listCandidates failed:`, e instanceof Error ? e.message : e); return [] }
    }),
  )
  return lists.flat().sort((a, b) =>
    haversineKm(lat, lon, a.lat, a.lon) - haversineKm(lat, lon, b.lat, b.lon) ||
    a.pricePerHr - b.pricePerHr)
}

// Try the atomic attach RPC for one region; on hit, stamp the session's srt_url
// fields + status (running if the hub is live, provisioning if still spawning).
async function attach(supabase: Supa, userId: string, region: string): Promise<AcquireHubResult | null> {
  const { data, error } = await supabase.rpc('attach_session_to_hub', { p_user_id: userId, p_region: region })
  if (error) { console.error('[vps-broker] attach rpc error:', error.message); return null }
  const hub = data as HubRow | null
  if (!hub) return null

  const live = hub.status === 'live'
  await supabase.from('gpu_instances').update({
    vps_hub_id: hub.id,
    topology: 'passthrough_only',
    needs_transcode: false,
    ip_address: hub.ip_address,
    srt_port: HUB_SRT_PORT,
    srt_passphrase: hub.srt_passphrase,   // the hub's SHARED passphrase (wildcard path)
    status: live ? 'running' : 'provisioning',
    phase: live ? 'ready' : 'requested',
    last_seen_at: live ? new Date().toISOString() : null,
  }).eq('user_id', userId)

  return {
    ok: true, attached: true, hubId: hub.id, ip: hub.ip_address,
    srtPort: HUB_SRT_PORT, status: live ? 'live' : 'spawning', region: hub.region ?? region,
  }
}

// Insert the spawning row (wins the spawn lock), mint the hub key, create the box,
// and persist its provider ids SYNCHRONOUSLY (primary-IP leak guard). Returns
// 'contended' if another request already holds the spawn lock for this region.
async function spawnHub(args: {
  supabase: Supa; userId: string; region: string; candidate: VpsCandidate
  imageTag: string; callbackUrl: string; lat: number; lon: number
}): Promise<{ ok: true } | { ok: false; contended: boolean; error?: string }> {
  const { supabase, userId, region, candidate, imageTag, callbackUrl, lat, lon } = args

  const hubKeyRaw = generateApiKey()
  const hubKeyHash = hashApiKey(hubKeyRaw)
  const srtPassphrase = generateApiKey().slice(0, 32)
  const panelPassword = generateApiKey().slice(0, 24)

  // Claim the spawn slot. Partial-unique vps_hubs(region) WHERE status='spawning'
  // makes a duplicate spawn fail here → caller falls back to attach.
  const { data: hubRow, error: insErr } = await supabase
    .from('vps_hubs')
    .insert({
      provider: candidate.provider,
      region,
      lat, lon,
      server_type: candidate.serverType,
      status: 'spawning',
      max_sessions: HUB_MAX_SESSIONS,
      session_count: 0,
      hub_key_hash: hubKeyHash,
      srt_passphrase: srtPassphrase,
      panel_password: panelPassword,
    })
    .select('id')
    .maybeSingle()

  if (insErr || !hubRow) {
    console.log(`[vps-broker] spawn lock contended for ${region} (${insErr?.message ?? 'no row'})`)
    return { ok: false, contended: true }
  }
  const hubId = hubRow.id as string

  // The hub's own 'vps' agent key (authorizes /api/agent/hub-config). agent_api_keys
  // requires a user_id; use the spawner's (the key is the box's, scoped via label).
  await supabase.from('agent_api_keys').insert({
    user_id: userId, key_hash: hubKeyHash, label: 'vps', node_role: 'vps', instance_id: hubId,
  })

  const cloudInit = buildCloudInit({
    imageTag,
    role: 'vps',
    imageLogin: parseImageLogin(),
    env: {
      SLIMCAST_API_KEY: hubKeyRaw,           // the hub authenticates to hub-config with this
      SLIMCAST_VERCEL_URL: callbackUrl,
      SLIMCAST_HUB_ID: hubId,
      SLIMCAST_SRT_PASSPHRASE: srtPassphrase, // shared passphrase for the wildcard SRT path
      RELAY_PASSWORD: panelPassword,
      RELAY_ROLE: 'vps',
    },
    ports: [
      { host: HUB_SRT_PORT, container: HUB_SRT_PORT, proto: 'udp' }, // SRT ingest (OBS → hub)
      { host: 1935, container: 1935, proto: 'tcp' },                 // RTMP readiness beacon
    ],
  })

  const provider = getVpsProvider(candidate.provider)
  let created
  try {
    created = await provider.create({
      candidate,
      name: `slimcast-hub-${region}-${hubId.slice(0, 8)}`,
      cloudInit,
    })
  } catch (e) {
    console.error('[vps-broker] hub create failed:', e instanceof Error ? e.message : e)
    // Free the spawn lock + revoke the key so a retry can spawn cleanly.
    await supabase.from('agent_api_keys').delete().eq('key_hash', hubKeyHash)
    await supabase.from('vps_hubs').delete().eq('id', hubId)
    return { ok: false, contended: false, error: 'hub create failed' }
  }

  // Persist provider ids SYNC before any further await — primary-IP leak guard
  // (the reaper can then release the billable IPv4 even if we die here).
  await supabase.from('vps_hubs').update({
    provider_id: created.vpsId,
    primary_ip_id: created.primaryIpId ?? null,
    ip_address: created.ip ?? null,
  }).eq('id', hubId)

  console.log(`[vps-broker] spawned hub ${hubId} (${candidate.label}) server=${created.vpsId} ip=${created.ip}`)
  return { ok: true }
}

/**
 * Get this stream a VPS hub: attach to the nearest existing hub with capacity, or
 * spawn one in the nearest region. Returns once the session is linked to a hub
 * (status 'live' → serveable now; 'spawning' → serveable when the hub POSTs /ready).
 */
export async function acquireHubOrSpawn(args: AcquireHubArgs): Promise<AcquireHubResult> {
  const { userId, lat, lon, imageTag, callbackUrl, supabase } = args

  const candidates = await rankCandidates(lat, lon)
  if (candidates.length === 0) return { ok: false, error: 'no VPS capacity available' }

  // Regions nearest-first (dedup, preserving order).
  const regions: string[] = []
  for (const c of candidates) if (!regions.includes(c.region)) regions.push(c.region)

  // 1) Attach to the nearest region that has a live-or-spawning hub with capacity.
  for (const region of regions) {
    const r = await attach(supabase, userId, region)
    if (r) return r
  }

  // 2) Nothing to join anywhere → spawn in the nearest region.
  const nearestRegion = regions[0]
  const spawnCandidate = candidates.filter(c => c.region === nearestRegion).sort((a, b) => a.pricePerHr - b.pricePerHr)[0]
  const spawn = await spawnHub({ supabase, userId, region: nearestRegion, candidate: spawnCandidate, imageTag, callbackUrl, lat, lon })
  if (!spawn.ok && !spawn.contended) {
    return { ok: false, error: spawn.error ?? 'hub spawn failed' }
  }

  // Whether we just spawned or lost the lock to a concurrent spawner, a spawning hub
  // now exists in the nearest region → attach this session to it.
  const joined = await attach(supabase, userId, nearestRegion)
  if (joined) return { ...joined, attached: spawn.ok ? false : true }
  return { ok: false, error: 'no hub available after spawn' }
}
