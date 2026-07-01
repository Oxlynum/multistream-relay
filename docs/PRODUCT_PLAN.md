# Productization Plan — HEVC/AV1 Cloud Transcoding Multistreamer

A plan for turning the working relay into a sellable, white-label product. This
is a planning document, not legal or financial advice — the licensing and
business sections flag where professional counsel is required before you charge
money.

---

## 1. The thesis

Most multistream services (Restream, Castr, StreamYard) have the streamer upload
**H.264**, which is bandwidth-hungry. Our edge: the streamer uploads **one
efficient HEVC (and later AV1) stream**, and a cloud GPU fans it out — transcoding
to whatever each platform needs. That single idea unlocks two underserved groups:

1. **Low-upload streamers** — people whose connection can't push a clean
   1080p60 H.264 stream, but *can* push HEVC at ~half the bitrate for the same
   quality. (Validated painfully in development: a ~5 Mbps real-world uplink that
   chokes on H.264 carries good 1080p60 in HEVC.)
2. **Multistreamers** — upload once, deliver to Twitch + Kick + YouTube without
   paying for three uploads' worth of home bandwidth.

The efficiency math is the whole pitch: HEVC ≈ 40–50% more efficient than H.264;
AV1 ≈ another ~30% on top. A 5 Mbps HEVC source looks like ~8 Mbps H.264.

---

## 2. Product model — self-hosted white-label

The key decision that de-risks the business: **the customer hosts their own
relay.** They buy the product (the OBS-side plugin + a deployable server image),
rent their own GPU box, and plug in their own platform keys.

Why this model wins:

- **You never hold customer stream keys or data.** They live on the customer's
  own server. This removes the single scariest liability of a streaming SaaS.
- **No orchestration/fleet to operate.** You're not provisioning GPUs or paying
  for their compute — they are. Your costs stay near zero per customer.
- **It's still "easy" if you do the packaging work** (Section 4). The customer
  experience is: deploy a template, copy two numbers into OBS, done.

The trade: you must make self-hosting genuinely painless, or support burden
eats you alive. Packaging is therefore the core product, not the codec pipeline
(which already works).

---

## 3. What already exists (the engine)

The hard technical core is built and proven end-to-end:

- HEVC ingest (enhanced-RTMP over TCP, or SRT over UDP where available).
- A media server (MediaMTX) that republishes the feed internally over SRT.
- A supervisor that runs one FFmpeg process per destination: NVENC H.264 for
  Twitch/Kick, HEVC passthrough (HLS) for YouTube — with auto-restart and a
  grace period.
- A web control panel (stream keys, bitrate, resolution, fps) that runs as an
  OBS custom browser dock.
- OBS-triggered auto start/stop (MediaMTX hooks).
- One-command install + launch scripts, pinned to a driver-compatible FFmpeg.

See `ARCHITECTURE.md` for the technical detail. Productization is about wrapping
this, not rebuilding it.

---

## 4. The setup-simplicity strategy (this is the actual product)

The development experience exposed exactly where the friction is — installing
packages, exposing ports, port mapping, editing config over SSH. **No paying
customer will tolerate any of that.** The product is whatever removes it:

**a) Prebuilt provider templates / images (highest-impact item).**
Publish a Docker image and per-provider one-click templates with the right ports
pre-exposed and the relay set to auto-run on boot. The customer clicks "Deploy"
and waits a minute — no SSH, no `setup.sh`. The Dockerfile already exists; this
is mostly turning it into published templates on each target provider.

**b) Provider presets in the plugin.**
The OBS-side plugin ships with URL templates per provider (RunPod, Vultr, AWS,
etc.) so the customer only enters numbers: server IP, the mapped ports, and their
stream keys. "Just inputting numbers," as specified.

**c) An OBS plugin / script for control + triggering.**
Today's browser dock works but is a generic web page. A light **OBS Python
script** (hooks OBS's own streaming start/stop events, exposes settings in OBS)
is the realistic "feels native" upgrade — about a day of work, no compiling. A
full native C++ plugin is weeks of work and only worth it for public
distribution; defer it.

**d) An installation guide with deploy links.**
Step-by-step per provider, with the ping-test-before-you-setup tip baked in.

Priority order: (a) → (b) → (d) → (c).

---

## 5. Codec strategy & roadmap

**HEVC — today.** Works now. Lean exclusively on **hardware/OS codecs**: Apple
VideoToolbox for the encode (already licensed by Apple), NVIDIA NVDEC for the
server-side decode, NVENC for the H.264 output. Avoid shipping any *software*
HEVC codec (see licensing).

**AV1 — the headline upgrade.** Royalty-free, ~30% more efficient than HEVC,
and increasingly accepted (YouTube already; Twitch enhanced broadcasting rolling
in). For a paid product this is a strong differentiator versus competitors who
owe HEVC royalties.

AV1 specifics that constrain the build:
- **AV1 hardware encode requires an Ada-class GPU** (NVIDIA RTX 40-series, L4,
  L40) or Intel Arc / AMD RDNA3. **Ampere (A16, A100) cannot AV1-encode.** So
  the AV1 tier must target Ada GPUs. (The RTX 4060 used early in development has
  AV1 encode; the Vultr A16 does not.)
- **Apple M-series (through M4) can decode but not hardware-encode AV1**, so AV1
  can't be the *uplink* codec from a Mac. (A PC on an Ada-class GPU / Intel Arc /
  AMD RDNA3 *can* AV1-encode, but the design keeps the uplink uniform: **HEVC from
  every source, Mac or PC.**) AV1 is a **server-side output**: the source sends
  HEVC up, the GPU transcodes HEVC → AV1 for platforms that want it.

Product framing: **HEVC uplink everywhere; H.264 output today; AV1 output as a
premium/"future-proof" tier on Ada-class servers.**

---

## 6. Licensing & legal posture

> Not legal advice. Get an hour with an IP/patent attorney before selling.

**HEVC is the licensing minefield.** Royalties are owed on *implementations*
(encoders/decoders) by patent pools — **Via LA** (MPEG LA + Velos Media) and
**Access Advance** (formerly HEVC Advance), plus some unpooled holders. Access
Advance has published HEVC pricing through 2030 and is **raising rates from
2026**, with deadlines to lock current rates. Exact per-unit schedules aren't
public — you contact the pools.

The posture that limits exposure: **only use already-licensed hardware/OS
codecs** (Apple VT, NVDEC, NVENC). The royalty burden for those implementations
sits with Apple/NVIDIA, who already paid it. The risk zone is shipping a
*software* HEVC codec (x265, FFmpeg's native HEVC) in your product. Mitigations:
have the customer's installer *pull* FFmpeg rather than bundling a software
codec; keep the pipeline on hardware decode/encode. This is not a guarantee —
pools sometimes argue the end product/service owes royalties regardless — but it
materially shrinks the surface. An attorney must confirm for your specific
packaging.

**AV1 is royalty-free** by design (AOMedia patent license, backed by Google,
Netflix, Amazon, Apple, Microsoft). Caveats to track: a Sisvel patent pool began
asserting AV1 royalties in 2025, and a Dolby v. Snap lawsuit is testing AV1's
royalty-free status. Lower risk than HEVC, strongly backed, not bulletproof.

**Other legal must-haves:** a clear ToS/EULA and disclaimer (self-hosting shifts
data responsibility to the customer, but you still want liability limits for
misconfiguration), platform terms compliance (Twitch/YouTube/Kick rules on apps
and ingest; multistreaming compliance — e.g., Kick's official Multistream
toggle), and a privacy stance (you hold no stream data — say so explicitly).

---

## 7. Hosting / provider strategy

The product's network quality depends on the customer picking the right host.
Two requirements drive everything:

- **UDP must be allowed** (for SRT, which makes weak/lossy uplinks usable). This
  is the single biggest quality lever for the low-bandwidth audience.
- **A datacenter near the customer** (low latency, low loss).

**RunPod is TCP-only (no UDP)** — fine for development and for users on great
connections, but it forces enhanced-RTMP and can't deliver SRT's resilience.
**UDP-capable hosts** (Vultr, AWS, Azure, GCP, GPU VPS providers) are the real
target — they let you open a UDP port and use SRT. Recommend Ada-class GPUs for
the AV1 tier; A16-class is fine for HEVC-only.

Document recommended providers + nearest-region guidance in the install guide,
with the "ping-test before setup" rule front and center.

---

## 8. Economics (sketch — validate before pricing)

Because customers self-host, your COGS per customer is near zero (no compute,
no bandwidth on your side). Revenue is product license / subscription.

Customer-side cost reality (what you're saving them vs. alternatives):
- A small transcoding GPU slice runs roughly $0.06–0.30/hr depending on provider
  and GPU. A customer streaming ~100 hrs/month spends on the order of $10–30 in
  compute — far less than they'd guess, and they control it.
- Bandwidth: three platforms at once ≈ ~20 Mbps out ≈ ~9 GB/hr; watch provider
  bandwidth caps (e.g., 1 TB/mo ≈ ~110 hrs of 3-platform streaming).

Pricing options to model: one-time plugin license, monthly subscription, or
tiered (HEVC tier vs AV1 tier). Benchmark against Restream/Castr monthly pricing,
positioning on (a) bandwidth savings the competitors can't match and (b) no
per-platform upload tax. Build a proper unit-economics model before launch.

---

## 9. MVP scope & roadmap

**Phase 0 — Validate (now).** Get a clean, stable 1080p60 stream end-to-end on a
UDP/SRT host near the user. Confirm Twitch, then Kick, then YouTube. This proves
the engine in real conditions.

**Phase 1 — One-click server.** Publish the Docker image + a provider template
(start with one UDP-capable provider) so deployment is click-and-wait. Kills the
terminal entirely.

**Phase 2 — Plugin UX.** OBS Python script + provider presets ("just enter
numbers") + install guide with deploy links. This is the sellable package.

**Phase 3 — AV1 tier.** Add AV1 output on Ada-class GPUs as a premium option.

**Phase 4 — Business layer.** Licensing/payment, ToS/EULA, support docs, and the
attorney review. Then launch to a small beta of low-bandwidth streamers.

**Phase 5 (optional) — Native plugin.** Full C++ OBS plugin if public
distribution justifies it.

---

## 10. Risks & open questions

- **HEVC licensing exposure** — resolve the packaging question with an attorney
  before charging. Biggest legal risk.
- **Support burden** — even self-serve, customers hit provider quirks (the
  UDP/TCP issue, port mapping, driver mismatches we lived through). The templates
  and guide must absorb most of this.
- **Provider variability** — UDP support, GPU availability, and bandwidth caps
  differ by provider and region; presets must encode this knowledge.
- **AV1 legal cloud** — track the Sisvel/Dolby situation; keep AV1 optional.
- **Platform terms drift** — Twitch/Kick/YouTube ingest and multistreaming rules
  change; stay current.
- **"Bring your own GPU" friction** — some target users may still find renting a
  GPU intimidating; the one-click template is what makes or breaks adoption.

---

## 11. Immediate next steps

1. Finish Phase 0: stable stream on the Vultr (Atlanta) + SRT box once approved.
2. Turn the Dockerfile into a published one-click template on that provider.
3. Draft the OBS Python script for native start/stop + settings.
4. Book the IP-attorney consult on the HEVC packaging question.
5. Build the unit-economics + pricing model against Restream/Castr.
