# SlimCast

**Consumer multistreaming, without the upload tax.** You stream **one** efficient HEVC feed
from OBS; SlimCast fans it out to **Twitch, Kick, YouTube, and TikTok** at once — and the
bandwidth-heavy fan-out leaves from a datacenter, not your home uplink. Nothing requires a
terminal: an OBS plugin drives the whole lifecycle from the Start Streaming button.

> **Works on Mac and PC.** Your source can be **any HEVC-capable hardware encoder** — Apple
> VideoToolbox on macOS, or NVIDIA NVENC / AMD AMF / Intel QSV on Windows. HEVC's efficiency is
> what carries clean 1080p60 (and 1440p) through a connection that could never push H.264.

## How it works

```
  OBS (Mac or PC)                Trusted VPS hub (Hetzner)              Cloud GPU (Vast / RunPod)
  any HEVC encoder    HEVC/SRT   ┌───────────────────────────┐  TLS   ┌─────────────────────────┐
  ───────────────────────────►  │ SRT ingest (:8890)         │ bridge │ HEVC-decode (NVDEC)      │
                                 │ • YouTube: HEVC passthrough│◄──────►│ H.264-encode (NVENC)     │
                                 │ • Twitch eRTMP passthrough │ :8899  │ returns H.264 to the hub │
                                 │ • transcode → bridge ─────►│        └─────────────────────────┘
                                 │ tee fan-out to platforms   │
                                 └───────────┬───────────────┘
                                             ▼
                              Twitch · Kick · YouTube · TikTok
```

- **One upload.** OBS publishes a single HEVC stream over **SRT** to a trusted VPS **hub**
  (Hetzner) — never directly to a rented GPU.
- **Passthrough is GPU-free.** YouTube (HLS) and eligible-Twitch (HEVC eRTMP) are served straight
  from the hub with no re-encode — no GPU rented.
- **Transcode is bridged.** For H.264 platforms (Kick, TikTok, non-eligible Twitch) the hub bridges
  the feed over **mpegts-over-TLS (TCP)** to a cloud GPU that HEVC-decodes → H.264-encodes and
  returns the video to the hub, which pushes to every platform.
- **Stream keys never reach the GPU.** The hub holds the keys and does all platform delivery; a
  rented GPU only transcodes and returns video.
- **No idle billing.** The hub and GPU are provisioned when you Start Streaming and torn down when
  you stop (a universal lease + reaper backstop cleans up orphans).

## Repository layout

| Path | What it is |
|---|---|
| `web/` | **Next.js 16 SaaS** — auth, dashboard, billing (Supabase + Stripe), the GPU/hub broker, and the OBS-dock API. Deploys to Vercel. |
| `relay/` | **The relay Docker image** run on both the hub and the GPU (`agent.py` dispatches on role). MediaMTX + jellyfin-ffmpeg + `supervisor.py`. Built by CI to GHCR. |
| `slimcast-obs/` | **The OBS plugin** (C++) — the dock that drives provisioning and streaming. Mac `.pkg` today; Windows `.exe` in progress (see [`macvpc.md`](macvpc.md)). |
| `mobile/` | **Planned** native mobile app ("phone-shaped OBS"). Design only so far. |
| `docs/` | Architecture notes + `docs/archive/` (historical/shipped design docs). |

## Where to start

- **[`CLAUDE.md`](CLAUDE.md)** is the deep, current reference — architecture invariants, the broker,
  billing, teardown/lease safety, the schema, and the load-bearing decisions. Read it before
  changing anything.
- **[`macvpc.md`](macvpc.md)** — the Mac-vs-Windows plugin status and the Windows-enablement plan.
- **Roadmap / test runbooks:** `gputest.md` (GPU transcode-bridge live test — the current #1
  unknown), `hevcpasstest.md` (hub passthrough — proven live), `dualstream.md` (vertical 9:16),
  `enterprise-audit.md` (hardening roadmap), `production-checklist.md` (pre-launch cutover).

## Status

- **Hub passthrough → YouTube: proven live** (OBS → Hetzner hub → YouTube, HEVC-over-HLS).
- **GPU transcode bridge: built, not yet proven on a provisioned GPU** — the mpegts-over-TLS
  transcode path has only run locally so far (`gputest.md` Phase 2).
- **Billing** is two-tier (PAYG + subscription) and **OFF by default** until launch.

> **Platform terms.** SlimCast streams within each platform's terms and does not hide simulcasting.
> Kick pays a reduced rate when you are not exclusive — use Kick's official Multistream toggle for
> full revenue eligibility.
