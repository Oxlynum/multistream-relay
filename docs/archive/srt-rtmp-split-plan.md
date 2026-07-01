# Plan: SRT→RTMP split (decouple UDP ingest from the GPU)

Status: **planned backup** (not yet built). Primary path remains verify-and-prefer
(Arch #8 `preferenceTier` + boot self-test). This expands availability past the
good-driver Vast pool when that pool is thin.

## Why
Two constraints currently shrink our GPU pool:
1. **SRT ingest is UDP**, so the GPU provider must forward UDP → rules out RunPod
   (TCP-only) and any TCP-only host.
2. **NVENC-in-container driver regression** (`nvidia-container-toolkit#1249`): Vast
   hosts on driver 570/580+ can't open NVENC in-container, so we must prefer the
   shrinking "good-driver" subset.

The intersection (UDP-capable **and** good-driver **and** cheap **and** near the
user) can be small — which is what stranded the live stream.

## Key insight
**SRT only matters on the lossy last mile (OBS → cloud).** Cloud→cloud links are
low-loss, so the GPU can be fed over **RTMP/TCP**. If we terminate SRT on a cheap
**CPU** edge and forward RTMP to the GPU, the GPU no longer needs UDP — which
**reopens RunPod (good curated drivers!) and any Vast GPU regardless of UDP**, and
lets us pick the GPU purely on NVENC-good-driver + price + availability.

## Architecture
```
OBS ──SRT(publish:<key>,passphrase,latency=5000)──▶  EDGE (cheap CPU, UDP-capable)
                                                       MediaMTX terminates SRT
                                                       ffmpeg -i srt://127.0.0.1:8890?streamid=read:<key>
                                                              -c copy -f flv rtmp://<gpu>:1935/<key>
                                                       (copy = no transcode, ~1 vCPU)
                                                            │ RTMP/TCP (cloud→cloud, low-loss)
                                                            ▼
                                              GPU POD (RunPod or any Vast GPU, good driver)
                                              existing pipeline: NVDEC → NVENC tee fan-out
                                                            │
                                                            ▼  Twitch / Kick / YouTube / TikTok
```
- **Edge**: cheapest UDP-capable CPU near the user. Runs MediaMTX (SRT in) + a
  `-c copy` ffmpeg forward to the GPU (no GPU needed, trivial CPU). Carries the SRT
  passphrase on the OBS leg; the edge→GPU RTMP leg is on a private/secret key.
- **GPU pod**: only needs **RTMP ingress (TCP)** now — so the relay image runs
  unchanged, MediaMTX just accepts RTMP publish instead of SRT. Selected by the
  broker on NVENC-good-driver + price (distance no longer matters — it's cloud→cloud).

## What changes in code
- **Relay**: support an RTMP-ingest mode (MediaMTX already binds `:1935`; today it's
  only a readiness beacon — flip it to an accepted publish path when in GPU-pod role).
  The edge role = MediaMTX SRT + a forward runner (reuse `OutputRunner` with a
  `-c copy` command).
- **Broker / providers**: a **composite candidate** = (edge, gpu) pair. Provision
  edge first (nearest UDP host), then GPU (best NVENC host on any provider incl.
  RunPod), wire the GPU's RTMP URL into the edge's forward target.
- **Re-add a RunPod GPU provider** (`lib/providers/runpod.ts`) — but ONLY as a GPU
  behind the edge (RTMP ingress), never as a direct SRT target. (Note: this reverses
  the "RunPod deleted" decision *only* for the behind-edge role.)
- **Pod safety (Arch #10)**: teardown must destroy BOTH instances atomically; the
  claim row needs to track the pair; reaper reconciles both. This is the main added
  risk surface — a half-torn-down pair bills.
- **Status/`gpu/status`**: `srt_url` points at the EDGE; the GPU IP is internal.

## Cost / tradeoffs
- **+1 cheap CPU instance** (~$0.02–0.05/hr) per stream. Negligible vs the GPU.
- **+1 network hop**: a few ms cloud→cloud; absorbed by the platform buffer (and the
  5s SRT buffer is on the OBS→edge leg, untouched).
- **More orchestration**: two instances to provision/bill/tear down → more failure
  modes; the pod-safety layers must cover the pair.
- **Upside**: much larger GPU pool (RunPod + all Vast GPUs), better/curated drivers
  (sidesteps #1249 entirely on RunPod), and GPU chosen on price not proximity.

## Phasing
- **Phase 0 (done):** verify-and-prefer primary fix.
- **Phase 1 (prototype):** manually rent a CPU edge + a RunPod 4090; wire SRT→edge→
  RTMP→GPU; confirm OBS goes live end-to-end and quality holds.
- **Phase 2 (broker):** composite candidate + paired teardown + RunPod-behind-edge
  provider; gate behind a flag.
- **Phase 3 (fallback tier):** use the split only when no good-driver UDP GPU is
  available near the user (a `preferenceTier` above the demoted-but-direct hosts, or
  a dedicated fallback pass). Direct good-driver Vast stays the cheapest happy path.
