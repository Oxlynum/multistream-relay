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
import { getVpsProvider, getProvider, ACTIVE_VPS_PROVIDERS, ACTIVE_GPU_PROVIDERS } from '@/lib/providers'
import { buildCloudInit } from '@/lib/cloud-init'
import { haversineKm, startProvisionRace, type RacerEntry, type UserOutputConfig } from '@/lib/gpu-broker'
import { teardownHub } from '@/lib/pod-teardown'
import { VPS_PRICE_CEILING, HUB_MAX_SESSIONS, VPS_READINESS_TIMEOUT_MS, BACKEND_PRICE_CEILING, FALLBACK_LAT, FALLBACK_LON } from '@/lib/datacenters'
import type { VpsCandidate } from '@/lib/providers/types'
import { podName, hubName } from '@/lib/managed-identity'

type Supa = ReturnType<typeof createServerClient>

// DEBUG-ONLY: attach registered SSH key id(s) to spawned hubs so an operator can SSH in
// and read `docker logs slimcast-relay` (the hub has no remote log surface — no :8080
// panel, no published debug port). Comma-separated registered Hetzner key ids. Passing
// ssh_keys at create also avoids Hetzner's expired-root-password PAM block. UNSET in
// normal prod (hubs get no key); set HETZNER_HUB_SSH_KEY_ID only while debugging.
const HUB_SSH_KEY_IDS = (process.env.HETZNER_HUB_SSH_KEY_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean)

// Fixed on Hetzner (container port == host == public, no remap). The relay binds
// SRT on 8890; we publish 8890/udp in the hub's cloud-init.
const HUB_SRT_PORT = 8890
// The VPS-hub return-ingest port: the GPU backend pushes its transcoded RTMPS/H.264
// back to the hub here (rtmps://hub:1936/return/<key>/<orient>). No DB column — a
// fixed constant per the locked decision; published as 1936/tcp in hub cloud-init.
const HUB_RETURN_PORT = 1936

// vps_hubs row shape returned by attach_session_to_hub (the columns we read).
interface HubRow {
  id: string
  status: string
  ip_address: string | null
  srt_passphrase: string | null
  region: string | null
  lat: number | null
  lon: number | null
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
  lat?: number | null             // hub coords — the GPU race anchors on these
  lon?: number | null
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
  // The PL/pgSQL function RETURNS vps_hubs, so on a no-match it returns an all-NULL
  // composite ({id:null, region:null, …}) — NOT SQL NULL. That object is truthy, so a
  // bare `if (!hub)` lets a PHANTOM hub through: acquireHubOrSpawn's attach loop then
  // does `if (r) return r` and short-circuits, never reaching spawnHub → no box is ever
  // created and the session "attaches" to nothing (hubId/lat/lon all null → Kansas
  // fallback). A real hub always has an id, so gate on it.
  if (!hub || !hub.id) return null

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
    lat: hub.lat, lon: hub.lon,
  }
}

// Insert the spawning row (wins the spawn lock), mint the hub key, create the box,
// and persist its provider ids SYNCHRONOUSLY (primary-IP leak guard). Returns
// 'contended' if another request already holds the spawn lock for this region.
async function spawnHub(args: {
  supabase: Supa; userId: string; region: string; candidate: VpsCandidate
  imageTag: string; callbackUrl: string; lat: number; lon: number
}): Promise<{ ok: true; hubId: string } | { ok: false; contended: boolean; error?: string }> {
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
      // Store the HUB SERVER's coords (EU), NOT the caller's (args lat/lon). The GPU
      // backend race anchors on these (it must land the GPU NEAR the hub — the bridge
      // return is loss-intolerant TCP). Storing the caller's US coords made the race
      // rank a US RunPod #1 and skip EU Vast entirely. Hub *selection* still uses the
      // caller's coords (rankCandidates, passed separately) to pick the nearest region.
      lat: candidate.lat, lon: candidate.lon,
      server_type: candidate.serverType,
      status: 'spawning',
      max_sessions: HUB_MAX_SESSIONS,
      // Box lease starts at spawn with the full readiness window (cloud-init +
      // docker-pull can take minutes). The first heartbeat tightens it to BOX_LEASE_MS.
      // A hub that boots but never heartbeats lapses past this and the universal
      // sweeper hard-destroys it — this replaces the cron-only spawn_timeout backstop.
      renew_deadline: new Date(Date.now() + VPS_READINESS_TIMEOUT_MS).toISOString(),
      // Start the scale-to-zero clock at spawn so a hub that boots but never gets a
      // tenant (e.g. a failed post-spawn attach) is still reaped — attach clears it
      // on the first tenant. (empty_since is now reconciled from the DERIVED live-lease
      // count, never a stored refcount.)
      empty_since: new Date().toISOString(),
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
    // Minimal "just docker run" cloud-init when the candidate boots from a pre-baked
    // snapshot (HETZNER_SNAPSHOT_ID set) — boots in seconds vs the apt+pull path.
    prebaked: candidate.prebaked,
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
      { host: HUB_SRT_PORT, container: HUB_SRT_PORT, proto: 'udp' },       // SRT ingest (OBS → hub)
      { host: 1935, container: 1935, proto: 'tcp' },                       // RTMP readiness beacon
      { host: HUB_RETURN_PORT, container: HUB_RETURN_PORT, proto: 'tcp' }, // GPU → hub RTMPS return ingest
    ],
  })

  const provider = getVpsProvider(candidate.provider)
  let created
  try {
    created = await provider.create({
      candidate,
      name: hubName(region, hubId),
      cloudInit,
      ...(HUB_SSH_KEY_IDS.length ? { sshKeyIds: HUB_SSH_KEY_IDS } : {}),
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
  return { ok: true, hubId }
}

// Reclaim hubs stuck in 'spawning' past the boot window (inserted the spawn-lock row
// but never POSTed /ready or /failed — e.g. a cloud-init image-pull failure). They'd
// otherwise hold the per-region spawn lock AND be excluded from attach (age guard),
// wedging the region until the daily cron. teardownHub destroys the box + frees the
// lock. Runs on every provision so the region self-heals promptly (review #5).
async function reclaimStuckSpawningHubs(supabase: Supa): Promise<void> {
  const cutoff = new Date(Date.now() - VPS_READINESS_TIMEOUT_MS).toISOString()
  const { data: stuck } = await supabase
    .from('vps_hubs')
    .select('id')
    .eq('status', 'spawning')
    .lt('created_at', cutoff)
  for (const s of stuck ?? []) {
    await teardownHub(s.id as string, 'stuck_spawning')
  }
}

/**
 * Get this stream a VPS hub: attach to the nearest existing hub with capacity, or
 * spawn one in the nearest region. Returns once the session is linked to a hub
 * (status 'live' → serveable now; 'spawning' → serveable when the hub POSTs /ready).
 */
export async function acquireHubOrSpawn(args: AcquireHubArgs): Promise<AcquireHubResult> {
  const { userId, lat, lon, imageTag, callbackUrl, supabase } = args

  // Clear any wedged 'spawning' hubs first so a stuck box can't block this region.
  await reclaimStuckSpawningHubs(supabase)

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

  // Attach failed right after WE spawned the box → tear it down now so it doesn't
  // leak (scale-to-zero would also catch it via empty_since, but this is prompt).
  // onlyIfEmpty: our attach can return null merely because a CONCURRENT tenant holds the
  // hub's FOR UPDATE row lock (attach_session_to_hub uses SKIP LOCKED) and we skipped it —
  // the claim re-validates derived occupancy under the same lock and ABORTS if that tenant
  // committed, so we never destroy a hub someone else just joined. A genuinely-empty
  // just-spawned hub (count 0) is still torn down.
  if (spawn.ok) {
    await teardownHub(spawn.hubId, 'attach_failed_after_spawn', { onlyIfEmpty: true })
  }
  return { ok: false, error: 'no hub available after spawn' }
}

export interface GpuBackendResult { ok: boolean; nodeId?: string; racerCount?: number; error?: string }

/**
 * Race a GPU BACKEND for a transcode tenant, anchored on the HUB's region (the bridge
 * return leg is loss-intolerant TCP, so the GPU must be near the VPS). Mints the 'gpu'
 * key + bridge_secret, inserts the per-session gpu_backend relay_nodes row, links it
 * onto gpu_instances (topology='vps_gpu', gpu_node_id, bridge_secret), and fans out the
 * race over ALL backend providers (Vast backend-mode + RunPod) — N=1 (the hub already
 * serves passthrough, so a slow GPU boot only delays transcode, never the stream).
 * On no-capacity: DEGRADE (mark the node ended/error) — NEVER fall back to direct-to-GPU.
 */
export async function startGpuBackendRace(args: {
  userId: string
  instanceId: string            // gpu_instances.id (relay_nodes.instance_id FK)
  hubLat: number | null
  hubLon: number | null
  imageTag: string
  callbackUrl: string
  userOutputs: UserOutputConfig[]
  supabase: Supa
}): Promise<GpuBackendResult> {
  const { userId, instanceId, hubLat, hubLon, imageTag, callbackUrl, userOutputs, supabase } = args

  const gpuRawKey = generateApiKey()
  const gpuKeyHash = hashApiKey(gpuRawKey)
  const bridgeSecret = generateApiKey().slice(0, 32)

  const { data: node, error: nodeErr } = await supabase
    .from('relay_nodes')
    .insert({
      instance_id: instanceId,
      user_id: userId,
      role: 'gpu_backend',
      provider: '',
      node_key_hash: gpuKeyHash,
      racers: [],
      race_round: 0,
      phase: 'requested',
      status: 'provisioning',
      // Box lease starts with the boot window; the first node heartbeat tightens it.
      // A backend that never pairs lapses past this and the sweeper destroys it (when
      // its parent session is gone; a live parent re-races via the cron floor).
      renew_deadline: new Date(Date.now() + VPS_READINESS_TIMEOUT_MS).toISOString(),
    })
    .select('id')
    .maybeSingle()
  if (nodeErr || !node?.id) {
    console.error('[vps-broker] gpu_backend relay_nodes insert failed:', nodeErr?.message)
    return { ok: false, error: 'gpu node insert failed' }
  }
  const nodeId = node.id as string

  await supabase.from('agent_api_keys').insert({
    user_id: userId, key_hash: gpuKeyHash, label: 'gpu', node_role: 'gpu', instance_id: nodeId,
  })
  await supabase.from('gpu_instances').update({
    topology: 'vps_gpu', needs_transcode: true, gpu_node_id: nodeId, bridge_secret: bridgeSecret,
  }).eq('user_id', userId)

  // The GPU learns its source dims + return URLs from /api/agent/gpu-config (per-tenant),
  // NOT env — so the boot env is minimal.
  const gpuEnv = [
    { key: 'SLIMCAST_API_KEY', value: gpuRawKey },
    { key: 'SLIMCAST_VERCEL_URL', value: callbackUrl },
    { key: 'RELAY_ROLE', value: 'gpu' },
    { key: 'SLIMCAST_BRIDGE_SECRET', value: bridgeSecret },
  ]

  // Serialize racer writes onto relay_nodes.racers (the documented concurrent-write fix).
  let racerWriteLock = Promise.resolve()
  const race = await startProvisionRace({
    lat: hubLat ?? FALLBACK_LAT,
    lon: hubLon ?? FALLBACK_LON,
    name: podName(userId),
    imageTag,
    env: gpuEnv,
    userOutputs,
    providers: ACTIVE_GPU_PROVIDERS,
    maxPricePerHr: BACKEND_PRICE_CEILING,
    racersN: 1,
    onRacerCreated: async (racer: RacerEntry) => {
      await (racerWriteLock = racerWriteLock.then(async () => {
        const { data: row } = await supabase.from('relay_nodes').select('racers').eq('id', nodeId).maybeSingle()
        if (!row) {
          // The parent session was torn down (CASCADE dropped this relay_nodes row)
          // between the parent re-check and this write. The freshly-created box can no
          // longer be tracked in any row → destroy it now rather than leak it (review #15).
          try { await getProvider(racer.provider).destroy(racer.provider_id) } catch { /* best effort */ }
          console.warn(`[vps-broker] race node ${nodeId} gone — destroyed orphan racer ${racer.provider_id}`)
          return
        }
        const current = (row.racers ?? []) as RacerEntry[]
        current.push(racer)
        // Stamp provider AT CREATE (Phase 2, item 1): the backend race is N=1, so the
        // sole racer IS the eventual winner — record its provider now so the row is never
        // left with provider='' (which getProvider rejects, and which used to silently
        // route a RunPod box's destroy to Vast → leak). /ready re-stamps the resolved
        // winner (same value); if it never fires, teardown still routes correctly.
        const { data: updated } = await supabase.from('relay_nodes')
          .update({ racers: current, phase: 'racing', status: 'provisioning', provider: racer.provider })
          .eq('id', nodeId).select('id').maybeSingle()
        if (!updated) {
          // Node vanished between the read and this write (same CASCADE race) → the box id
          // is now untracked → destroy it so it can't bill invisibly (review #15).
          try { await getProvider(racer.provider).destroy(racer.provider_id) } catch { /* best effort */ }
          console.warn(`[vps-broker] race node ${nodeId} vanished on write — destroyed orphan racer ${racer.provider_id}`)
        }
      }))
    },
  })

  if (!race.started) {
    console.error(`[vps-broker] gpu backend race found no capacity for ${userId}: ${race.error}`)
    await supabase.from('relay_nodes').update({ phase: 'ended', status: 'error' }).eq('id', nodeId)
    return { ok: false, nodeId, error: race.error }
  }
  console.log(`[vps-broker] gpu backend race started for ${userId}: node=${nodeId} racers=${race.racerCount}`)
  return { ok: true, nodeId, racerCount: race.racerCount }
}

/**
 * Re-race a GPU BACKEND for an EXISTING gpu_backend relay_nodes row — used by the
 * reaper when a GPU dies MID-STREAM (last_seen_at stale) while the user is still
 * live on the hub (passthrough keeps serving). Rotates the node's 'gpu' key (so the
 * dead box can't re-auth), resets the node for a fresh race, and fans out a new N=1
 * backend race anchored on the hub's region. The session's bridge_secret is REUSED
 * (the hub already trusts it; the return URLs are unchanged). On no-capacity the node
 * DEGRADES (phase='ended') — the hub passthrough outputs keep serving.
 *
 * Single-caller (the reaper) so no CAS is needed on race_round — we just bump it.
 */
export async function reraceGpuBackend(nodeId: string, supabase: Supa): Promise<GpuBackendResult> {
  // node → its session → the hub it bridges to (for the geo anchor). Also read the
  // dead box's provider/provider_id + racers so we can destroy them BEFORE the reset
  // below discards their ids (otherwise the rented GPU bills until the daily orphan
  // reconcile on Vast, or FOREVER on RunPod — landmine #4).
  const { data: node } = await supabase
    .from('relay_nodes')
    .select('instance_id, node_key_hash, race_round, provider, provider_id, racers')
    .eq('id', nodeId)
    .maybeSingle()
  if (!node?.instance_id) return { ok: false, error: 'gpu node not found' }

  // Destroy the dead box(es) before we discard their ids. Route each by its OWN racer
  // provider — the top-level node.provider can be '' if the box died before /ready
  // persisted the winner. Best-effort; the reaper orphan-reconcile backstops survivors.
  const killed = new Set<string>()
  for (const r of (node.racers ?? []) as RacerEntry[]) {
    if (r.provider_id && !killed.has(r.provider_id)) {
      killed.add(r.provider_id)
      try { await getProvider(r.provider).destroy(r.provider_id) }
      catch (e) { console.warn(`[vps-broker] re-race dead box destroy ${r.provider_id} failed:`, e) }
    }
  }
  if (node.provider_id && !killed.has(node.provider_id as string)) {
    // Strict (no `|| 'vast'`): provider is stamped at create now, so a blank here is a bug
    // we want to surface — the throw is caught and the box falls to the reaper's orphan
    // reconcile (which sweeps non-Vast providers too), not silently mis-routed to Vast.
    try { await getProvider(node.provider as string).destroy(node.provider_id as string) }
    catch (e) { console.warn(`[vps-broker] re-race dead winner destroy ${node.provider_id} failed:`, e) }
  }

  const { data: inst } = await supabase
    .from('gpu_instances')
    .select('user_id, vps_hub_id, bridge_secret')
    .eq('id', node.instance_id)
    .maybeSingle()
  if (!inst?.user_id) return { ok: false, error: 'parent session not found' }
  const userId = inst.user_id as string

  let hubLat: number | null = null
  let hubLon: number | null = null
  if (inst.vps_hub_id) {
    const { data: hub } = await supabase
      .from('vps_hubs')
      .select('lat, lon')
      .eq('id', inst.vps_hub_id)
      .maybeSingle()
    hubLat = hub?.lat ?? null
    hubLon = hub?.lon ?? null
  }

  // Rotate the gpu key: mint a NEW one, revoke the OLD (a zombie GPU can't re-auth).
  const newRawKey = generateApiKey()
  const newKeyHash = hashApiKey(newRawKey)
  if (node.node_key_hash) {
    await supabase.from('agent_api_keys').delete().eq('key_hash', node.node_key_hash)
  }
  await supabase.from('agent_api_keys').insert({
    user_id: userId, key_hash: newKeyHash, label: 'gpu', node_role: 'gpu', instance_id: nodeId,
  })

  // Reset the node for a fresh race (new key, clear racers + addr, bump the round).
  // last_seen_at MUST be nulled too: otherwise a re-race off the mid-stream-death
  // lineage inherits the dead box's stale timestamp, so if the REPLACEMENT box is
  // created (billing) but never POSTs /ready|/failed, the node sits at
  // stale && phase='racing' && sessionLive — matching NO reaper branch (b needs
  // ready/streaming, b2 needs neverPaired, a needs !sessionLive) and bills for the
  // rest of the session. Nulling it re-presents a failed re-race as 'never paired'
  // so (b2)/(a) re-catch it next sweep (neverPaired is anchored on created_at).
  await supabase.from('relay_nodes').update({
    node_key_hash: newKeyHash,
    racers: [],
    race_round: (node.race_round ?? 0) + 1,
    phase: 'racing',
    status: 'provisioning',
    ip_address: null,
    bridge_in_port: null,
    last_seen_at: null,
    // Fresh boot-window lease for the re-raced box (last_seen_at is nulled, so the
    // lease — not staleness — governs it until the new box pairs and heartbeats).
    renew_deadline: new Date(Date.now() + VPS_READINESS_TIMEOUT_MS).toISOString(),
  }).eq('id', nodeId)

  const imageTag = process.env.SLIMCAST_RELAY_IMAGE || 'ghcr.io/oxlynum/multistream-relay:latest'
  const callbackUrl = process.env.SLIMCAST_AGENT_CALLBACK_URL ?? 'https://slimcast-oxlynum.vercel.app'
  const gpuEnv = [
    { key: 'SLIMCAST_API_KEY', value: newRawKey },
    { key: 'SLIMCAST_VERCEL_URL', value: callbackUrl },
    { key: 'RELAY_ROLE', value: 'gpu' },
    { key: 'SLIMCAST_BRIDGE_SECRET', value: (inst.bridge_secret as string | null) ?? '' },
  ]

  // Serialize racer writes onto relay_nodes.racers (same lock pattern as the race).
  let racerWriteLock = Promise.resolve()
  const race = await startProvisionRace({
    lat: hubLat ?? FALLBACK_LAT,
    lon: hubLon ?? FALLBACK_LON,
    name: podName(userId),
    imageTag,
    env: gpuEnv,
    providers: ACTIVE_GPU_PROVIDERS,
    maxPricePerHr: BACKEND_PRICE_CEILING,
    racersN: 1,
    onRacerCreated: async (racer: RacerEntry) => {
      await (racerWriteLock = racerWriteLock.then(async () => {
        const { data: row } = await supabase.from('relay_nodes').select('racers').eq('id', nodeId).maybeSingle()
        if (!row) {
          // The parent session was torn down (CASCADE dropped this relay_nodes row)
          // between the parent re-check and this write. The freshly-created box can no
          // longer be tracked in any row → destroy it now rather than leak it (review #15).
          try { await getProvider(racer.provider).destroy(racer.provider_id) } catch { /* best effort */ }
          console.warn(`[vps-broker] race node ${nodeId} gone — destroyed orphan racer ${racer.provider_id}`)
          return
        }
        const current = (row.racers ?? []) as RacerEntry[]
        current.push(racer)
        // Stamp provider AT CREATE (Phase 2, item 1): the backend race is N=1, so the
        // sole racer IS the eventual winner — record its provider now so the row is never
        // left with provider='' (which getProvider rejects, and which used to silently
        // route a RunPod box's destroy to Vast → leak). /ready re-stamps the resolved
        // winner (same value); if it never fires, teardown still routes correctly.
        const { data: updated } = await supabase.from('relay_nodes')
          .update({ racers: current, phase: 'racing', status: 'provisioning', provider: racer.provider })
          .eq('id', nodeId).select('id').maybeSingle()
        if (!updated) {
          // Node vanished between the read and this write (same CASCADE race) → the box id
          // is now untracked → destroy it so it can't bill invisibly (review #15).
          try { await getProvider(racer.provider).destroy(racer.provider_id) } catch { /* best effort */ }
          console.warn(`[vps-broker] race node ${nodeId} vanished on write — destroyed orphan racer ${racer.provider_id}`)
        }
      }))
    },
  })

  if (!race.started) {
    console.error(`[vps-broker] gpu re-race found no capacity for ${userId}: ${race.error}`)
    await supabase.from('relay_nodes').update({ phase: 'ended', status: 'error' }).eq('id', nodeId)
    return { ok: false, nodeId, error: race.error }
  }
  console.log(`[vps-broker] gpu re-race started for ${userId}: node=${nodeId} racers=${race.racerCount}`)
  return { ok: true, nodeId, racerCount: race.racerCount }
}
