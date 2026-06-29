export interface PodEnv {
  key: string
  value: string
}

// One concrete, LOCATION-STAMPED option the broker can try: a specific GPU at a
// specific place, from a specific provider. The broker merges candidates from
// every provider into one list, ranks them by distance-to-user (then price), and
// creates them nearest-first until one boots. Because each candidate carries its
// own coordinates, every provider's offers rank against each other uniformly —
// "closest server wins" spans providers for free.
export interface GpuCandidate {
  provider: string        // owning provider name (e.g. 'vast'); routes create/destroy
  gpuKey: string          // our short key, stored on the instance for observability
  gpuTypeId: string       // the provider's own GPU identifier
  pricePerHr: number      // catalog/offer price — cheapest-first tiebreak + ceiling
  lat: number             // where this option physically is — for nearest-first ranking
  lon: number
  label: string           // human-readable, e.g. 'vast:12345 Frankfurt'
  // Soft preference tier — LOWER is tried first, ahead of distance/price. Lets a
  // provider demote (NOT exclude) hosts it has reason to distrust, while the pod's
  // own boot self-test stays the hard gate. Default 0 (no preference). Vast uses
  // tier 1 for GPUs that hit the NVENC-in-container driver regression
  // (Ada/Blackwell on driver ≥570, nvidia-container-toolkit#1249): still eligible,
  // just sorted last so good-driver hosts win when available. Extensible to other
  // backup paths (e.g. an SRT→RTMP-split CPU relay fronting a non-UDP GPU).
  preferenceTier?: number
  driverVersion?: string  // host GPU driver, when known — for ranking + broker logs
  // Opaque provider-specific payload handed back to create() to place the pod.
  // Vast: { offerId, machineId }. The broker never inspects it.
  placement: Record<string, unknown>
}

export interface CreatedPod {
  podId: string
  costPerHr?: number   // actual hourly price, if the provider reports it
}

export interface PodStatus {
  status: string
  ip: string | null
  port: number | null          // public mapped port for the RTMP beacon (1935/tcp)
  hlsPort: number | null       // public mapped port for the HLS preview server (8888)
  dataCenterId: string | null  // location the pod landed in, if the provider reports it (null on Vast)
  srtPort?: number | null      // public mapped UDP port for SRT ingest (8890/udp); null if not mapped
  udpProbePort?: number | null // public mapped UDP echo port (8889/udp) used to verify the host forwards UDP
}

// A cloud GPU provider. Vast.ai is implemented today (see vast.ts); the broker
// ranks across every active provider. The only requirements: deterministic
// placement (put the pod where listCandidates said), and UDP-capable hosts (SRT
// ingest is the only OBS→pod transport).
export interface GpuProvider {
  name: string

  // Every location-stamped option this provider can offer at or under maxPricePerHr.
  // Vast: a live offer search — each returned machine is actually available, with
  //   its real geolocation and price.
  // Best-effort: should resolve to [] (not throw) if the provider is unreachable,
  // so one provider being down never blocks the others.
  // `mode` distinguishes the legacy all-in-one pod (OBS ingests SRT/UDP directly →
  // needs UDP ports) from the VPS-hub GPU BACKEND (receives an mpegts-over-TCP bridge
  // → no UDP, fewer ports, tiny in-region egress). Defaults to 'all-in-one' so the
  // existing path is unchanged.
  listCandidates(opts: { maxPricePerHr: number; needsProfessionalGpu: boolean; mode?: 'all-in-one' | 'backend' }): Promise<GpuCandidate[]>

  create(args: {
    candidate: GpuCandidate
    name: string
    imageTag: string
    env: PodEnv[]
    mode?: 'all-in-one' | 'backend'
  }): Promise<CreatedPod>

  getStatus(podId: string): Promise<PodStatus>
  stop(podId: string): Promise<void>
  destroy(podId: string): Promise<void>

  // List this provider's currently-live instances so the reaper can reconcile against
  // real infrastructure and destroy any instance the DB has no row for. This is the
  // ONLY path that catches a true orphan (created, but the row write lost a race / the
  // function died), so every billing provider must implement it — without it, a stray
  // rental bills forever.
  //   - MUST already be filtered to OUR boxes (managed-by:slimcast / name prefix): the
  //     reaper destroys whatever this returns that has no DB row, so a provider that
  //     leaks unrelated account boxes here would have them destroyed.
  //   - `ownerId` is the 8-char user/hub prefix parsed from the managed name (or null
  //     if absent) so the reaper's mid-provision guard can spare a box whose DB row is
  //     still being written, WITHOUT re-parsing the name itself (lib/managed-identity).
  // Best-effort: resolve to [] (don't throw) if the provider is unreachable.
  listInstances(): Promise<Array<{ id: string; name: string; ownerId: string | null }>>
}

// ─────────────────────────────────────────────────────────────────────────────
// VPS-as-the-Hub provider surface (Phase 0 scaffolding, behind SLIMCAST_VPS_HUB).
//
// A VPS provider is DELIBERATELY a separate interface from GpuProvider — never
// generalize the two. Vast stays 100% untouched so it can't regress, and the two
// box types differ in shape: a VPS has FIXED public ports (container port == host
// port == public, no marketplace remap), bundled bandwidth (not per-TB metered),
// and a primary IPv4 that is a SEPARATE billable resource which survives server
// deletion (the #1 leak — destroy() must release it). It rents from a fixed
// regional catalog, not a live offer marketplace, so there's no per-offer
// geolocation step: regions carry their own coordinates.
// ─────────────────────────────────────────────────────────────────────────────

// One rentable VPS option: a server type in a specific region. The broker picks
// the nearest region with capacity, then the cheapest adequate server type there.
export interface VpsCandidate {
  provider: string        // owning provider ('hetzner'); routes create/destroy
  serverType: string      // provider's server-type id (e.g. 'cpx31' — verify live, NOT 'cpx32')
  region: string          // provider region/location id (e.g. 'ash', 'fsn1')
  pricePerHr: number      // hourly price (Hetzner bills per hour, ROUNDED UP)
  includedTrafficTb: number   // bundled egress before overage (Hetzner ~20TB)
  pricePerTbOverage: number   // $/TB once the bundle is exceeded
  lat: number             // region centroid — for nearest-region ranking + GPU anchoring
  lon: number
  label: string           // human-readable, e.g. 'hetzner:cpx31 Ashburn'
  // True when this candidate boots from a PRE-BAKED image (a snapshot that already has
  // Docker + the relay image) → the broker hands cloud-init a minimal "just docker run"
  // user_data (boots in seconds) instead of the full apt-install + pull. Set by the
  // provider (Hetzner: when HETZNER_SNAPSHOT_ID is configured). Top-level (not in the
  // opaque `placement`) so the broker can pick the cloud-init mode without inspecting it.
  prebaked?: boolean
  // Opaque provider payload handed back to create(). Hetzner: { serverType, location,
  // image, datacenter? }. The broker never inspects it.
  placement: Record<string, unknown>
}

export interface CreatedVps {
  vpsId: string           // provider server id
  primaryIpId?: string    // Hetzner primary-IP resource id — MUST be released on destroy
  ip?: string | null      // public IPv4 if known at create
  costPerHr?: number
}

export interface VpsStatus {
  status: string          // provider lifecycle ('running'|'initializing'|'off'|...)
  ip: string | null       // public IPv4
  primaryIpId: string | null   // so teardown can release it even if create's return was lost
  region: string | null
}

// A bundled-bandwidth VPS provider (Hetzner first; Vultr later as a second entry
// in ACTIVE_VPS_PROVIDERS — zero broker change). Ports are fixed, so there's no
// port-mapping discovery: the relay binds the same ports we tell the broker.
export interface VpsProvider {
  name: string

  // The rentable catalog at or under maxPricePerHr, one VpsCandidate per
  // (serverType × region) that can handle the hub workload. Derived from the
  // provider's LIVE server-type + region APIs (server-type ids drift; never
  // hardcode them). Best-effort: resolve to [] (don't throw) if unreachable.
  listCandidates(opts: { maxPricePerHr: number }): Promise<VpsCandidate[]>

  create(args: {
    candidate: VpsCandidate
    name: string            // server name + the label the reaper matches on
    cloudInit: string       // #cloud-config user_data (installs Docker, runs the relay role)
    sshKeyIds?: string[]    // provider ssh-key ids to inject (debug access)
    firewallIds?: string[]  // provider firewall ids to attach
  }): Promise<CreatedVps>

  getStatus(vpsId: string): Promise<VpsStatus>

  // Destroy MUST be idempotent AND release the primary IPv4: on Hetzner the IP is
  // a separate resource that survives server deletion and bills ~€0.50/mo forever
  // if leaked. Order: delete server, THEN release the primary IP.
  destroy(vpsId: string, opts?: { primaryIpId?: string | null }): Promise<void>

  // Live servers (label-filtered to managed-by:slimcast) so the reaper can destroy any
  // box the DB has no row for. `ownerId` is the hub-id prefix parsed from the name (or
  // null) for the reaper's mid-spawn guard. Best-effort: [] on failure.
  listInstances(): Promise<Array<{ id: string; name: string; ownerId: string | null }>>

  // Release any DETACHED auxiliary billable resource this provider leaked — a resource
  // that SURVIVES server deletion and has no DB row to drive a lease (Hetzner: a primary
  // IPv4 whose server is already gone; ~€0.50/mo forever). listInstances() lists SERVERS,
  // so a server-less orphan IP is invisible to it — this is its only catchall. Filtered
  // to managed-by:slimcast + UNASSIGNED only (never touch an in-use resource). Returns the
  // count released. Optional: a provider with no detached-resource model omits it.
  // Best-effort: resolve (don't throw) if the provider is unreachable.
  releaseAux?(): Promise<number>
}
