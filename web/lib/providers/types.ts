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
  listCandidates(opts: { maxPricePerHr: number; needsProfessionalGpu: boolean }): Promise<GpuCandidate[]>

  create(args: {
    candidate: GpuCandidate
    name: string
    imageTag: string
    env: PodEnv[]
  }): Promise<CreatedPod>

  getStatus(podId: string): Promise<PodStatus>
  stop(podId: string): Promise<void>
  destroy(podId: string): Promise<void>

  // List this provider's currently-live instances (id + the name/label set at
  // create) so the reaper can reconcile against real infrastructure and destroy
  // any instance the DB has no row for. This is the ONLY path that catches a true
  // orphan (created, but the row write lost a race / the function died), so every
  // billing provider must implement it — without it, a stray rental bills forever.
  // Best-effort: resolve to [] (don't throw) if the provider is unreachable.
  listInstances(): Promise<Array<{ id: string; name: string }>>
}
