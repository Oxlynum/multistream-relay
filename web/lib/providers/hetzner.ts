import type { VpsProvider, VpsCandidate, CreatedVps, VpsStatus } from './types'
import { ownerOfHubName, MANAGED_BY } from '../managed-identity'

// Hetzner Cloud provider — the first VPS hub backend for VPS-as-the-Hub.
//
// Unlike Vast (a GPU marketplace), Hetzner is a fixed-catalog host: a handful of
// server types, each priced per location, with BUNDLED traffic (not per-TB
// metered). Key facts that shaped this file:
//   - Bills PER HOUR, ROUNDED UP. (Lifecycle = long-lived multi-tenant hubs so a
//     restart doesn't buy a fresh billed hour — see vps-hub-plan.md §1a.)
//   - The primary IPv4 is a SEPARATE billable resource (~€0.50/mo) that SURVIVES
//     server deletion. destroy() MUST release it (delete server, THEN delete the
//     primary IP) or it leaks forever. This is the #1 leak risk.
//   - Ports are FIXED: container port == host == public, no remap to discover.
//   - Rate limit: 3600 req/hr (shared by broker + reaper — see §10 open item 5).
//
// Verified against the live API with scripts/test-hetzner.mjs (server-type catalog
// + create → status → destroy → release-IP lifecycle). Don't trust the shapes here
// until that round-trip passes — same discipline as vast.ts.

const BASE = 'https://api.hetzner.cloud/v1'
const TOKEN = process.env.HETZNER_API_TOKEN

// Default OS image for the hub. cloud-init installs Docker on top.
const DEFAULT_IMAGE = process.env.HETZNER_IMAGE || 'ubuntu-22.04'

// Pre-baked snapshot (Phase 4): a snapshot image id that already has Docker enabled +
// the relay image pulled. When set, hubs boot from it and cloud-init skips apt+pull
// (seconds, well under the readiness window) — see scripts/build-hetzner-snapshot.mjs.
// Unset (prod default) → fall back to DEFAULT_IMAGE + the full install cloud-init.
// REBUILD the snapshot whenever the relay image changes (it bakes a specific image).
const SNAPSHOT_ID = process.env.HETZNER_SNAPSHOT_ID || ''

// Soft floor for a server type to be a viable hub: it must terminate SRT + remux +
// (for transcode) source-forward + platform fan-out. Tune after the §2.6 load-test;
// these keep the absurdly tiny tiers (cpx11/cx22) out of the candidate set for now.
const MIN_CORES = Number(process.env.HETZNER_MIN_CORES || 2)
const MIN_MEMORY_GB = Number(process.env.HETZNER_MIN_MEMORY_GB || 4)

// EU-only-by-economics. Hetzner ships its ~20–22 TB traffic bundle ONLY on the EU
// locations (fsn1/nbg1/hel1); US (ash/hil) + Singapore cap at ~1 TB and bill overage,
// as do the OLD low-bundle lines (cpx11–51) everywhere. The first leg is SRT (5000 ms
// buffer absorbs the transatlantic RTT — quality-safe, sub-second-latency cost only),
// so we deliberately pin hubs to the 20 TB-bundle locations to slash egress cost. This
// resolves to EU. included_traffic is PER-LOCATION on each price, so the filter is exact:
// cx23@fsn1 (22 TB) passes, the SAME cx23@ash (1 TB) does not. Tunable; an explicit
// region allowlist (HETZNER_ALLOWED_REGIONS=fsn1,nbg1,hel1) can hard-pin geography on top.
const MIN_INCLUDED_TRAFFIC_TB = Number(process.env.HETZNER_MIN_INCLUDED_TRAFFIC_TB || 18)
const ALLOWED_REGIONS = (process.env.HETZNER_ALLOWED_REGIONS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

const BYTES_PER_TB = 1_000_000_000_000

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
}

async function hzFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(10000),
  })
}

// ── live catalog shapes (defensive: fields are read with ?. and defaulted) ────
interface HzLocation {
  id: number
  name: string
  city?: string
  country?: string
  latitude?: number
  longitude?: number
  network_zone?: string
}

interface HzPrice {
  location: string
  price_hourly?: { gross?: string; net?: string }
  price_monthly?: { gross?: string; net?: string }
  included_traffic?: number               // bytes
  price_per_tb_traffic?: { gross?: string; net?: string }
}

interface HzServerType {
  id: number
  name: string                            // e.g. 'cpx31' (NOT 'cpx32' — that id is invented)
  cores: number
  memory: number                          // GiB
  disk: number
  architecture?: string                   // 'x86' | 'arm'
  cpu_type?: string                       // 'shared' | 'dedicated'
  deprecation?: unknown | null            // non-null → deprecated, skip
  prices?: HzPrice[]
}

interface HzServer {
  id: number
  name?: string
  status?: string
  datacenter?: { location?: HzLocation }
  public_net?: { ipv4?: { id?: number; ip?: string } | null }
  labels?: Record<string, string>
}

function num(s: string | undefined, fallback = 0): number {
  const n = s != null ? parseFloat(s) : NaN
  return Number.isFinite(n) ? n : fallback
}

export const hetznerProvider: VpsProvider = {
  name: 'hetzner',

  async listCandidates({ maxPricePerHr }): Promise<VpsCandidate[]> {
    if (!TOKEN) return []
    try {
      // Pull the live catalog: server types (with per-location pricing) + locations
      // (for real lat/lon). Both are small, single-page responses.
      const [stRes, locRes, dcRes] = await Promise.all([
        hzFetch('/server_types?per_page=50'),
        hzFetch('/locations'),
        hzFetch('/datacenters'),
      ])
      if (!stRes.ok || !locRes.ok || !dcRes.ok) {
        console.error(`[hetzner] catalog fetch → server_types ${stRes.status}, locations ${locRes.status}, datacenters ${dcRes.status}`)
        return []
      }
      const serverTypes = ((await stRes.json()).server_types ?? []) as HzServerType[]
      const locations = ((await locRes.json()).locations ?? []) as HzLocation[]
      const locByName = new Map(locations.map(l => [l.name, l]))
      // A type's PRICE list includes locations where it currently has NO capacity — retired
      // lines (e.g. cpx11) and drained locations (e.g. fsn1) still appear. Ordering one 422s
      // with "unsupported location for server type" → spawnHub deletes its row and the hub
      // never comes up. The authoritative "orderable right now" signal is each datacenter's
      // server_types.available list; intersect against it.
      const datacenters = ((await dcRes.json()).datacenters ?? []) as Array<{ location?: { name?: string }; server_types?: { available?: number[] } }>
      const orderable = new Set<string>()   // `${typeId}@${locationName}`
      for (const dc of datacenters) {
        const ln = dc.location?.name
        if (!ln) continue
        for (const tid of dc.server_types?.available ?? []) orderable.add(`${tid}@${ln}`)
      }

      // Snapshot disk floor: Hetzner refuses to restore a snapshot onto a server type
      // whose disk is SMALLER than the snapshot's (422 "image disk is bigger than server
      // type disk"). Our relay snapshot is baked on an 80GB box, so the cheapest 40GB
      // types (cx23/cpx11) must be excluded when SNAPSHOT_ID is set. Read the snapshot's
      // disk_size and floor the candidate types on it. (0 = no snapshot → no floor.)
      let snapshotDiskGb = 0
      if (SNAPSHOT_ID) {
        try {
          const imgRes = await hzFetch(`/images/${SNAPSHOT_ID}`)
          if (imgRes.ok) snapshotDiskGb = Number(((await imgRes.json()).image?.disk_size) ?? 0)
          else console.error(`[hetzner] snapshot ${SNAPSHOT_ID} lookup → ${imgRes.status} (disk floor disabled)`)
        } catch (e) { console.error('[hetzner] snapshot disk_size fetch failed:', e instanceof Error ? e.message : e) }
      }

      const candidates: VpsCandidate[] = []
      for (const st of serverTypes) {
        if (st.deprecation) continue                                  // skip deprecated lines
        if ((st.architecture ?? 'x86') !== 'x86') continue            // relay image is amd64
        if ((st.cores ?? 0) < MIN_CORES) continue
        if ((st.memory ?? 0) < MIN_MEMORY_GB) continue
        if (snapshotDiskGb > 0 && (st.disk ?? 0) < snapshotDiskGb) continue   // snapshot won't fit this disk → would 422 at create
        for (const pr of st.prices ?? []) {
          const loc = locByName.get(pr.location)
          if (!loc || loc.latitude == null || loc.longitude == null) continue
          const hourly = num(pr.price_hourly?.gross)
          if (hourly <= 0 || hourly > maxPricePerHr) continue
          const includedTrafficTb = (pr.included_traffic ?? 0) / BYTES_PER_TB
          // Drop 1 TB US/SG locations + old low-bundle lines: only 20 TB-bundle (EU) hubs.
          if (includedTrafficTb < MIN_INCLUDED_TRAFFIC_TB) continue
          if (ALLOWED_REGIONS.length && !ALLOWED_REGIONS.includes(pr.location)) continue
          if (!orderable.has(`${st.id}@${pr.location}`)) continue   // skip price-only / drained combos
          candidates.push({
            provider: 'hetzner',
            serverType: st.name,
            region: pr.location,
            pricePerHr: hourly,
            includedTrafficTb,
            pricePerTbOverage: num(pr.price_per_tb_traffic?.gross),
            lat: loc.latitude,
            lon: loc.longitude,
            label: `hetzner:${st.name} ${loc.city ?? loc.name} (${st.cores}c/${st.memory}g)`,
            // Boot from the pre-baked snapshot when configured (cloud-init goes minimal);
            // else the base image + full install path. `prebaked` tells the broker which.
            prebaked: !!SNAPSHOT_ID,
            placement: { serverType: st.name, location: pr.location, image: SNAPSHOT_ID || DEFAULT_IMAGE },
          })
        }
      }
      return candidates
    } catch (err) {
      console.error('[hetzner] listCandidates failed:', err instanceof Error ? err.message : err)
      return []
    }
  },

  async create({ candidate, name, cloudInit, sshKeyIds, firewallIds }): Promise<CreatedVps> {
    if (!TOKEN) throw new Error('HETZNER_API_TOKEN not set')
    const body: Record<string, unknown> = {
      name,
      server_type: candidate.placement.serverType,
      location: candidate.placement.location,
      image: candidate.placement.image ?? DEFAULT_IMAGE,
      user_data: cloudInit,
      start_after_create: true,
      // IPv4 only (we don't use IPv6 for ingest); IPv4 is the billable primary IP
      // we must release on destroy.
      public_net: { enable_ipv4: true, enable_ipv6: false },
      labels: { 'managed-by': 'slimcast' },
    }
    if (sshKeyIds?.length) body.ssh_keys = sshKeyIds
    if (firewallIds?.length) body.firewalls = firewallIds.map(id => ({ firewall: Number(id) }))

    const res = await hzFetch('/servers', { method: 'POST', body: JSON.stringify(body) })
    const text = await res.text()
    let j: { server?: HzServer; error?: { message?: string } } = {}
    try { j = JSON.parse(text) } catch { /* non-JSON */ }
    if (!res.ok || !j.server?.id) {
      throw new Error(`Hetzner create → ${res.status}: ${j.error?.message ?? text.slice(0, 200)}`)
    }
    const ipv4 = j.server.public_net?.ipv4 ?? null
    const primaryIpId = ipv4?.id != null ? String(ipv4.id) : undefined
    // Two things on the auto-created primary IP, in ONE PUT:
    //   (a) auto_delete=true — the FIRST-LINE defense: Hetzner releases the IP automatically
    //       when its server is deleted. It defaults true, but we set it EXPLICITLY so the
    //       no-leak guarantee doesn't depend on an undocumented default.
    //   (b) managed-by:slimcast label — so releaseAux() can find the IP if it ever DOES
    //       orphan (a server-less IP is invisible to listInstances(), which lists servers).
    // public_net.enable_ipv4 creates the IP UNLABELED, so we tag it here. Best-effort — a
    // failure only weakens the aux-sweep backstop; auto_delete (the default) + teardownHub's
    // explicit release still cover the normal path, so it must never fail the provision.
    if (primaryIpId) {
      try {
        await hzFetch(`/primary_ips/${primaryIpId}`, {
          method: 'PUT',
          body: JSON.stringify({ auto_delete: true, labels: { 'managed-by': MANAGED_BY } }),
        })
      } catch (err) {
        console.error(`[hetzner] label primary_ip ${primaryIpId} failed:`, err instanceof Error ? err.message : err)
      }
    }
    return {
      vpsId: String(j.server.id),
      primaryIpId,
      ip: ipv4?.ip ?? null,
      costPerHr: candidate.pricePerHr,
    }
  },

  async getStatus(vpsId): Promise<VpsStatus> {
    const res = await hzFetch(`/servers/${vpsId}`)
    if (res.status === 404) return { status: 'terminated', ip: null, primaryIpId: null, region: null }
    if (!res.ok) return { status: 'unknown', ip: null, primaryIpId: null, region: null }
    const srv = ((await res.json()).server ?? {}) as HzServer
    const ipv4 = srv.public_net?.ipv4 ?? null
    return {
      status: srv.status ?? 'unknown',
      ip: ipv4?.ip ?? null,
      primaryIpId: ipv4?.id != null ? String(ipv4.id) : null,
      region: srv.datacenter?.location?.name ?? null,
    }
  },

  // Idempotent. Primary-IP lifecycle (confirmed live via test-hetzner.mjs 2026-06-28):
  // the auto-created primary IP defaults to auto_delete=true, so Hetzner releases it
  // ASYNCHRONOUSLY once the server teardown completes — there's NO synchronous window
  // in which to delete it ourselves (an assigned IP returns 422). So:
  //   1. Delete the server.
  //   2. Touch the IP ONLY if it's already UNASSIGNED — a genuine orphan (auto_delete
  //      was somehow false). An assigned IP is mid-auto-delete (or awaiting the async
  //      server teardown); deleting it now 422s, so we leave it to auto_delete and the
  //      reaper backstop (which sweeps unassigned managed primary IPs). This is what
  //      eliminated the old false "RELEASE FAILED" alarm.
  // A 404 anywhere is success (already gone).
  async destroy(vpsId, opts): Promise<void> {
    // Resolve the primary IP id up front (before the server is gone) if not supplied,
    // so the reaper path (which only knows the IP from getStatus) still works.
    let primaryIpId = opts?.primaryIpId ?? null
    if (!primaryIpId) {
      try { primaryIpId = (await this.getStatus(vpsId)).primaryIpId } catch { /* best-effort */ }
    }
    try {
      const dr = await hzFetch(`/servers/${vpsId}`, { method: 'DELETE' })
      if (!dr.ok && dr.status !== 404) {
        console.error(`[hetzner] delete server ${vpsId} → ${dr.status}`)
      }
    } catch (err) {
      console.error(`[hetzner] delete server ${vpsId} failed:`, err instanceof Error ? err.message : err)
    }
    if (primaryIpId) {
      try {
        const gr = await hzFetch(`/primary_ips/${primaryIpId}`)
        if (gr.status === 404) {
          // already released by auto_delete — nothing to do (the common path)
        } else if (gr.ok) {
          const ip = ((await gr.json()).primary_ip ?? {}) as { assignee_id?: number | null }
          if (ip.assignee_id == null) {
            // genuine orphan (auto_delete was false) → release it now
            const ir = await hzFetch(`/primary_ips/${primaryIpId}`, { method: 'DELETE' })
            if (!ir.ok && ir.status !== 404) {
              console.error(`[hetzner] release orphan primary_ip ${primaryIpId} → ${ir.status}`)
            }
          }
          // else: still assigned → auto_delete / reaper will release it (don't 422-spam)
        }
      } catch (err) {
        console.error(`[hetzner] primary_ip ${primaryIpId} cleanup check failed:`, err instanceof Error ? err.message : err)
      }
    }
  },

  // Label-filtered to managed-by=slimcast so the reaper only ever reconciles our
  // own boxes (never touches anything else in the Hetzner project). `ownerId` is the
  // hub-id prefix parsed from the name for the reaper's mid-spawn guard.
  async listInstances(): Promise<Array<{ id: string; name: string; ownerId: string | null }>> {
    if (!TOKEN) return []
    try {
      const res = await hzFetch(`/servers?label_selector=${encodeURIComponent(`managed-by=${MANAGED_BY}`)}`)
      if (!res.ok) { console.error(`[hetzner] list servers → ${res.status}`); return [] }
      const arr = ((await res.json()).servers ?? []) as HzServer[]
      return arr.map(s => ({ id: String(s.id), name: s.name ?? '', ownerId: ownerOfHubName(s.name) }))
    } catch (err) {
      console.error('[hetzner] list servers failed:', err instanceof Error ? err.message : err)
      return []
    }
  },

  // Release LEAKED primary IPv4s — the one billable resource that survives server
  // deletion (~€0.50/mo forever) and is INVISIBLE to listInstances() (which lists
  // servers, not IPs). The normal path is covered three ways already (auto_delete=true,
  // teardownHub passing primaryIpId, destroy()'s unassigned-IP check); this is the pure
  // catchall for an IP whose server is already gone. Strictly bounded to our own
  // (managed-by:slimcast, labeled at create) AND UNASSIGNED (assignee_id == null) IPs, so
  // it can never touch an in-use IP or anything not ours. Returns the count released.
  async releaseAux(): Promise<number> {
    if (!TOKEN) return 0
    let released = 0
    try {
      const res = await hzFetch(`/primary_ips?label_selector=${encodeURIComponent(`managed-by=${MANAGED_BY}`)}`)
      if (!res.ok) { console.error(`[hetzner] list primary_ips → ${res.status}`); return 0 }
      const ips = ((await res.json()).primary_ips ?? []) as Array<{ id: number; assignee_id?: number | null }>
      for (const ip of ips) {
        if (ip.assignee_id != null) continue   // assigned to a live server — leave it
        try {
          const dr = await hzFetch(`/primary_ips/${ip.id}`, { method: 'DELETE' })
          if (dr.ok || dr.status === 404) released++
          else console.error(`[hetzner] release orphan primary_ip ${ip.id} → ${dr.status}`)
        } catch (err) {
          console.error(`[hetzner] release primary_ip ${ip.id} failed:`, err instanceof Error ? err.message : err)
        }
      }
    } catch (err) {
      console.error('[hetzner] releaseAux failed:', err instanceof Error ? err.message : err)
    }
    return released
  },
}
