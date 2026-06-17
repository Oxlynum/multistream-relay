# HEVC → H.264 Transcoding Multistreamer — Architecture & Plan

Stream 1080p60 fast-paced FPS (Call of Duty, Destiny 2) from a Mac mini M4
to Twitch, Kick and YouTube simultaneously, using a rented RTX 4060 on RunPod
as a cloud transcode + fan-out relay.

> Multistreaming note: this is built to run **within each platform's terms**.
> Kick allows simulcasting but pays a reduced rate when you're not exclusive —
> use Kick's official "Multistream" toggle if you want full revenue eligibility.
> Nothing here hides simulcasting from any platform.

---

## 1. Why a cloud relay at all

Your Mac uploads **one** HEVC stream to the RunPod box. The box decodes once and
fans out to every platform on **RunPod's** bandwidth, not yours. So your modest
10–20 Mbps uplink only ever carries a single stream — the three outbound streams
(which together can exceed 24 Mbps) leave from the datacenter.

```
                 ~10-12 Mbps HEVC                  RunPod RTX 4060 (datacenter uplink)
  Mac mini M4  ───────────────────────►  ┌─────────────────────────────────────────┐
  OBS, HEVC                              │  MediaMTX (ingest, TCP)                    │
  enhanced-RTMP                          │      │ republish locally (RTSP, loopback) │
                                         │      ▼                                     │
                                         │  ┌───────────── relay supervisor ───────┐ │
                                         │  │ YouTube : HEVC copy → HLS (no re-enc) │─┼─► YouTube (HEVC)
                                         │  │ Twitch  : NVENC H.264 → RTMP          │─┼─► Twitch  (H.264)
                                         │  │ Kick    : NVENC H.264 → RTMP(S)       │─┼─► Kick    (H.264)
                                         │  └───────────────────────────────────────┘ │
                                         │  Control panel (web UI) on HTTP port        │
                                         └─────────────────────────────────────────────┘
```

---

## 2. The transport decision (and the RunPod gotcha)

The original plan was SRT for the Mac→cloud hop. **RunPod Pods do not forward UDP**,
and SRT is UDP-only, so SRT can't reach the pod through normal RunPod networking.

The fix that keeps your HEVC source intact: **Enhanced RTMP carrying HEVC over TCP.**
OBS 30+ negotiates HEVC (and AV1) over enhanced RTMP with a server that advertises
support. MediaMTX advertises it. This rides RunPod's **Direct TCP** port mapping with
no quality loss — it's a bitstream transport, not a re-encode.

| Option | Carries HEVC? | Works through RunPod? | Verdict |
|---|---|---|---|
| SRT (UDP) | yes | **no** (UDP blocked) | not usable on RunPod Pods |
| Plain RTMP (TCP) | no (H.264 only) | yes | loses your HEVC source |
| **Enhanced-RTMP HEVC (TCP)** | **yes** | **yes** | **chosen** |

If you ever move off RunPod to a box with a real public IP + UDP (a bare VPS, AWS,
etc.), switch the uplink back to SRT — MediaMTX accepts SRT ingest too, and the
relay logic is unchanged.

---

## 3. End-to-end pipeline

**Ingest (MediaMTX, runs always).** Listens for enhanced-RTMP HEVC on the pod's
exposed TCP port. Remuxes (no transcode) and republishes the live feed on a
loopback RTSP URL (`rtsp://127.0.0.1:8554/live`) that the encoders pull from.
Loopback RTSP/TCP is lossless and rock-solid — no packet loss like a network UDP hop.

**Egress (the supervisor, one FFmpeg process per platform).** Each enabled output
pulls the loopback feed and does its own thing, independently. If one platform
connection drops, the others keep running, and the supervisor auto-restarts the
dead one with backoff.

- **YouTube** — `-c copy` of the HEVC bitstream into HLS TS segments, PUT to
  YouTube's HLS ingest URL. Zero re-encode = zero added quality loss.
- **Twitch** — NVDEC decode → `h264_nvenc` → RTMP. Twitch ingest is H.264-only.
- **Kick** — NVDEC decode → `h264_nvenc` → RTMP(S). Kick accepts generous bitrates.

One decode, then separate NVENC encodes. The RTX 4060's 8th-gen NVENC handles
multiple simultaneous 1080p60 H.264 encodes without breaking a sweat.

---

## 4. Encoder tuning for high-motion FPS (the "crisp" part)

Fast camera pans in COD/Destiny are where bitrate and AQ earn their keep. Defaults
baked into the relay:

- `-preset p7 -tune hq -multipass fullres` — highest-quality NVENC mode (Ada).
- `-rc cbr` with `bufsize == bitrate` — streaming-stable, platform-friendly.
- `-bf 3 -b_ref_mode middle` — B-frames as references, better detail at the same bitrate.
- `-rc-lookahead 20` — lets the encoder spend bits where motion spikes.
- `-spatial-aq 1 -temporal-aq 1 -aq-strength 8` — preserves texture/detail across
  the frame and over time; the single biggest visible win in fast motion.
- `-g {fps*2}` — 2-second keyframe interval, aligned with OBS and HLS segments.

**Bitrate is king for FPS.** Set each platform as high as it allows:

| Platform | Practical 1080p60 ceiling | Notes |
|---|---|---|
| Twitch | ~6,000–8,500 kbps | Higher only via Enhanced Broadcasting / partner. 8000 is a safe aggressive default. |
| Kick | ~8,000+ kbps | Generous; you can push higher than Twitch. |
| YouTube | source bitrate (passthrough) | Re-encodes on their side anyway; HEVC source ~10–12 Mbps is plenty. |

These are editable live from the control panel.

**Source bitrate from the Mac.** With a 10–20 Mbps uplink, target the HEVC source at
~60–70% of your *measured stable* upload (run a speed test). Roughly 10–12 Mbps HEVC
at 1080p60 looks excellent and transcodes cleanly to 8 Mbps H.264 (HEVC is ~40–50%
more efficient, so a 10 Mbps HEVC source has more real detail than an 8 Mbps H.264 one).

---

## 5. OBS settings on the Mac mini M4

- **Encoder:** Apple VT H265 Hardware Encoder (the M4's media engine).
- **Rate control:** CBR, bitrate ≈ 10,000–12,000 kbps (fit your uplink).
- **Keyframe interval:** **2 s** (fixed — required so YouTube HLS segments and the
  NVENC GOP line up cleanly).
- **Profile:** main. **Resolution:** 1920×1080. **FPS:** 60.
- **Audio:** AAC, 160 kbps, 48 kHz, stereo.
- **Stream service:** *Custom…*
  - Server: `rtmp://<RUNPOD_PUBLIC_IP>:<TCP_PORT>/live`
  - Stream key: `stream` (or whatever you set; the relay pulls `/live`)
- OBS must be **v30 or newer** for enhanced-RTMP HEVC.

---

## 6. RunPod setup essentials

- Use a **Secure Cloud** pod for a **stable public IP** (Community Cloud IPs can
  change on restart/migration).
- In the pod/template **Expose TCP Ports**, add:
  - `1935` — RTMP ingest (OBS → pod). Note the mapped external port in
    *Connect → TCP Port Mapping*; OBS uses that external port.
  - `8080` — control-panel web UI (reach it via the RunPod HTTP proxy or the
    direct TCP mapping).
- GPU: any RTX 4060 (Ada) instance. NVENC + NVDEC are the only GPU features used.
- The control panel handles **stream keys** — protect it. A panel password is
  required (env `RELAY_PASSWORD`); never expose it unauthenticated.

---

## 7. Control panel (frontend)

A single-page web UI served by the relay lets you, live, without SSH:

- edit **stream keys / ingest URLs** per platform,
- set **max bitrate** per platform,
- set **output resolution and FPS** per platform (e.g. send Kick 1080p60 but a
  720p60 copy somewhere else),
- enable/disable each destination,
- **start / stop / restart** the whole pipeline or one output,
- watch per-output **status** (running / restarting / error) and a **live log tail**.

Changes are saved to `config.json` and applied by restarting only the affected
FFmpeg processes.

---

## 8. Things to verify on first run (honest caveats)

- This code is written carefully but **cannot be tested against live Twitch/Kick/
  YouTube endpoints from here** — first run is on your pod.
- Confirm your **MediaMTX build accepts enhanced-RTMP HEVC** (current releases do;
  pinned in the Dockerfile).
- **YouTube HLS** is the fiddliest leg: create an *HLS* stream key in YouTube Studio,
  copy the ingestion URL into the panel. If segments are rejected, drop YouTube to
  H.264 transcode mode (one toggle) as a fallback.
- Watch the first few minutes of each platform's stream-health dashboard for dropped
  frames and adjust bitrate down if the platform reports congestion.
