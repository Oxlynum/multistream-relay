> **📦 ARCHIVED — SUPERSEDED by `hevcpasstest.md`,** where the VPS-hub passthrough was proven live. This older runbook is dead. Moved here 2026-06-30.

# VPS-Hub Live Test — Prove OBS → SlimCast → Hetzner Hub → YouTube (HEVC passthrough)

> Goal: prove the **passthrough-only** path end-to-end with **NO GPU**: OBS pushes HEVC over
> SRT to a Hetzner VPS hub, the hub `-c copy`s it to YouTube over HLS, YouTube goes live.
> This is Phase-1 sub-step **S12** (the only open item — everything else is built & shipped).
> Once green, the GPU bridge (Phase 2, for Kick/TikTok/non-eligible-Twitch) is the next layer.
>
> Defer Twitch/Kick/TikTok for this test — any non-passthrough output triggers a GPU backend race.

---

## 0. The data path (so the moving parts are unambiguous)

**Control plane = Vercel/Supabase. Data plane = OBS↔Hub↔YouTube (never touches Vercel).**

```
                         ┌──────────────────── VERCEL (control plane) ────────────────────┐
                         │  /api/gpu/provision   → acquireHubOrSpawn (Hetzner)             │
   OBS plugin ───────────┤  /api/gpu/status      → hands OBS the srt_url (→ the HUB)        │
   (Bearer user key)     │  /api/agent/ready     → hub flips vps_hubs.status = live         │
                         │  /api/agent/hub-config→ per-tenant outputs (decrypted keys)      │
                         │  /api/agent/status    → Clock A heartbeat + scale-to-zero        │
                         └───────────────▲───────────────────────────▲────────────────────┘
                                         │ (hub 'vps' key)            │ (hub 'vps' key)
            srt_url (polled)             │ poll every 10s             │ heartbeat
                │                        │                            │
                ▼                        │                            │
   ┌─────────┐  SRT/UDP :8890   ┌────────┴───────────────────────────┴───┐  HLS PUT   ┌─────────┐
   │  OBS    │ ───────────────► │  HETZNER HUB  (RELAY_ROLE=vps, CPU)     │ ─────────► │ YouTube │
   │ (HEVC)  │  publish:<key>   │  MediaMTX wildcard SRT + per-tenant     │  -c copy   │  (HEVC) │
   └─────────┘                  │  Supervisor: build_passthrough_cmd      │  hvc1      └─────────┘
                                └─────────────────────────────────────────┘
```

- **Per stream**, `provision` mints a unique 24-char `ingest_key` and stores it on `gpu_instances`.
- The hub has **one shared SRT passphrase** + a **MediaMTX wildcard path**; isolation = the
  unguessable `ingest_key` in the streamid. OBS publishes `publish:<key>`, the hub reads
  `read:<key>` on loopback, one `Supervisor(role=vps)` per tenant runs the passthrough ffmpeg.
- `gpu/status` builds `srt_url = srt://<hubIP>:8890?streamid=publish:<key>&latency=5000&passphrase=<shared>&pbkeylen=16`.
  The shipped OBS plugin reads `info.srtUrl` once `status=="running"` — **no plugin re-release needed**.

---

## 1. Current state (verified 2026-06-29 — it's primed)

- ✅ Web control plane (S1–S6, S9–S11) shipped behind the flag.
- ✅ Relay `vps` role (`main_vps`), `mediamtx.vps.yml` wildcard, per-tenant `hook.sh` flag — shipped.
- ✅ Relay CI green; `SLIMCAST_RELAY_IMAGE` re-pinned by CI 2h ago to the Phase-2 SHA
  (includes `main_vps` + the `aac_adtstoasc/hvc1` YouTube fix + TLS-cert fix).
- ✅ Prod env present: `SLIMCAST_VPS_HUB`, `HETZNER_API_TOKEN`, `HETZNER_SNAPSHOT_ID`,
  `HETZNER_HUB_SSH_KEY_ID` (SSH debug into hubs), `SLIMCAST_ALLOWED_EMAILS` (private-dev gate).
- ✅ Snapshot staleness is **safe**: `cloud-init` prebaked path does `ghcr login` + `docker run`
  with `--pull missing`, so if the baked SHA ≠ the pinned SHA it pulls the pinned one. The hub
  always runs the exact pinned image. (Staleness only costs boot seconds, never stale code.)

---

## 2. Pre-flight checklist (the gotchas that will silently fail the test)

| # | Check | Why it matters |
|---|---|---|
| 1 | `SLIMCAST_VPS_HUB=true` in Vercel prod (value is hidden on pull — confirm explicitly) | If `false`/unset, provision takes the **Vast all-in-one** path, not the hub. |
| 2 | Test account's email is in `SLIMCAST_ALLOWED_EMAILS` | Provision returns **403** otherwise (private-dev gate). |
| 3 | **Only YouTube enabled** in the dashboard; Twitch/Kick/TikTok **disabled**; YouTube orientation = **landscape** | A non-passthrough output → `needsTranscode=true` → a **GPU backend race** fires (what we're deferring). YouTube *portrait* is transcode too. |
| 4 | YouTube stream key saved in SlimCast (encrypted) + a live broadcast created in YouTube Studio | The hub builds `…/http_upload_hls?cid=<key>…`. No valid broadcast = YouTube drops the push. |
| 5 | OBS output codec = **HEVC** (Apple VT, Mac mini M4), AAC audio, res = `SOURCE_WIDTH/HEIGHT` (1080p default, or 1440p only with `has_2k_addon`) | Passthrough is `-c copy` + `-tag:v hvc1`. If OBS sends H.264, YouTube gets H.264 mislabeled as HEVC → reject. |
| 6 | `SLIMCAST_BILLING_ACTIVE` ≠ `true` | Keeps it free; `hub-config` returns large `credits_seconds` so the relay never self-stops on credits. |
| 7 | Your SSH public key is the one registered as `HETZNER_HUB_SSH_KEY_ID` (for `docker logs` access) | Hubs are the only window into the data plane — see §3. |

Confirm flag (name visible; value hidden by Vercel — re-set it to be certain):
```bash
vercel env ls production | grep SLIMCAST_VPS_HUB
# To force-set: printf 'true' | vercel env add SLIMCAST_VPS_HUB production  (then redeploy)
```

---

## 3. Observability map — and the ONE gap to fix first

| Hop | Where to look | Ground truth? |
|---|---|---|
| Provision / hub lifecycle | Vercel logs `vercel logs --environment=production --since=15m -x` (`[provision]`, `[vps-broker]`, `[agent/ready] vps hub … live`) | Control plane only |
| Hub row state | Supabase `vps_hubs` + `gpu_instances` (§5 queries) | DB |
| Hub boot / MediaMTX / OBS-connect | SSH to hub → `docker logs -f slimcast-relay` (agent.py + MediaMTX stdout + hook lines) | **Yes** for ingest |
| **Passthrough ffmpeg** (the copy → YouTube) | ⚠️ **INVISIBLE today** — see gap below | — |
| YouTube receiving / live | **YouTube Studio → Live Control Room** (health, bitrate, "receiving data") | **Yes** for delivery |

### ⚠️ The gap (confirmed in code)
On `RELAY_ROLE=vps` the hub **does not** run the `:8080` debug panel (`main_vps` skips
`start_uvicorn`), maps **no** 8080 port, and `_FFMPEG_STDERR_TO_STDOUT` is `gpu`-only. So if OBS
connects and the hub applies the config but **YouTube shows nothing**, the passthrough ffmpeg is
failing **silently** — its stderr is buffered in an in-memory ring no one can read.

**Two mitigations (do at least the first):**
1. **Stage A below** validates the exact passthrough command against YouTube *before* the hub test,
   so we already trust the command when we get to the hub (turns a silent failure into a known-good).
2. **(Recommended) 1-line relay tweak** so the hub logs ffmpeg stderr to `docker logs`:
   `relay/supervisor.py:301` →
   `_FFMPEG_STDERR_TO_STDOUT = os.environ.get("RELAY_ROLE", "") in ("gpu", "vps")`
   Safe: stream keys / the YouTube `cid` are already scrubbed by `_redact`. Requires a relay
   rebuild (push `relay/**` → CI auto-pins) + rebuild the Hetzner snapshot afterward.

---

## 4. The test — staged bottom-up so failure localizes

### Stage A — YouTube reachability (no SlimCast, ~5 min)
Prove the account + key + the exact passthrough command, with zero cloud infra. Run on any box
with ffmpeg (use a HEVC test source; this isolates YouTube + the command from OBS/SRT/hub):
```bash
# Replace <KEY> with the real YouTube stream key. Mirrors build_passthrough_cmd().
ffmpeg -re -f lavfi -i testsrc2=size=1920x1080:rate=60 -f lavfi -i sine=frequency=1000 \
  -c:v hevc_videotoolbox -tag:v hvc1 -b:v 6000k \
  -c:a aac -b:a 160k -ar 48000 -ac 2 \
  -bsf:a aac_adtstoasc \
  -f hls -method PUT -http_persistent 1 -hls_time 2 -hls_list_size 5 \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_flags 'delete_segments+omit_endlist+independent_segments' \
  "https://a.upload.youtube.com/http_upload_hls?cid=<KEY>&copy=0&file=stream.m3u8"
```
**Pass:** YouTube Studio shows "receiving data" and the preview goes live.
**If it fails here**, the problem is YouTube-side (key, broadcast not created, HEVC/HLS not
accepted on that account) or the command — **not** SlimCast. Fix before Stage B.

### Stage B — end-to-end through the hub
Do the pre-flight (§2). Then, in order:

**B0 · Hub spawns & goes live.** Trigger provision (OBS "Start Streaming", or `POST
/api/gpu/provision` with the user key). Watch:
- Vercel: `[vps-broker] spawned hub …` then `[agent/ready] vps hub <id> live ip=<ip>`.
- Supabase: a `vps_hubs` row → `status: spawning` → `live`; your `gpu_instances` row →
  `vps_hub_id` set, `topology=passthrough_only`, `needs_transcode=false`, `status` →
  `running`, `ip_address` = hub IP.
- Hetzner: exactly one `slimcast-hub-*` server.
- SSH: `docker logs slimcast-relay` shows `RELAY_ROLE=vps`, `MediaMTX running`, `Reporting hub ready`.

**B1 · SRT ingest reaches the hub.** OBS gets `srt_url` (status `running`) and publishes.
- OBS: Settings → Stream shows a `srt://<hubIP>:8890?...publish:<key>...` server; stream connects.
- Hub `docker logs`: MediaMTX `[SRT] … opened` for `publish:<key>`, then
  `hook: OBS connected (path='<key>')` and `Tenant <key8>… attached`.
- File present: `docker exec slimcast-relay ls /tmp/obs_connected.<key>`.

**B2 · Hub applies the passthrough.**
- Hub `docker logs`: `Tenant <key8>… OBS publishing — applying 1 output(s).`
- MediaMTX shows a **loopback read** (`read:<key>`) connection (the passthrough ffmpeg reading back).
- With the §3 tweak: ffmpeg lines (`Opening 'https://a.upload.youtube.com/...'`, HLS segment writes).

**B3 · YouTube goes live. ← THE PROOF.**
- YouTube Studio: "receiving data" → stream health green → broadcast live with your OBS content.

**B4 · Clean teardown (no leaks).** Stop in OBS.
- Tenant detaches (`gpu_instances` row removed/ended) — the **box is NOT destroyed** (multi-tenant).
- Idle hub → Clock B **scale-to-zero** (~10 min) destroys the server **and releases the primary IP**.
- Verify: Hetzner has **0** `slimcast-hub-*` servers and **0** unassigned `managed-by:slimcast`
  primary IPs; `vps_hubs` row gone/`ended`.

---

## 5. Supabase watch queries (dashboard SQL editor, or `psql`)

```sql
-- hub lifecycle
select id, status, region, ip_address, provider_id, primary_ip_id,
       empty_since, last_seen_at, created_at
from vps_hubs order by created_at desc limit 5;

-- this session's binding to the hub
select user_id, status, phase, vps_hub_id, topology, needs_transcode,
       left(ingest_key,8) as key8, ip_address, srt_port, last_seen_at
from gpu_instances order by created_at desc limit 5;

-- make sure ONLY youtube (landscape) is enabled for the test account
select platform, enabled, orientation, twitch_hevc_eligible, twitch_use_passthrough
from platform_connections where user_id = '<USER_UUID>';
```

## SSH into a hub
```bash
# hub IP from vps_hubs.ip_address (or Hetzner console)
ssh root@<hub_ip>            # key must match HETZNER_HUB_SSH_KEY_ID; ~30s after boot
docker logs -f slimcast-relay
```

---

## 6. Twitch auto-pick (your secondary point — already automatic)

It already works the way you described — no change needed for this test, and Twitch should be
**disabled** during it:
- `lib/twitch-eligibility.ts` calls Twitch `GetClientConfiguration` with the saved **stream key**;
  `encoder_configurations[0].type == 'hevc'` → eligible (Partner/select-Affiliate 2K tier), `h264`
  → not. Probed on key-save / OAuth / manual re-check, stored on `platform_connections`
  (`twitch_hevc_eligible`, `twitch_use_passthrough`, …).
- `classifyMode()` routes Twitch to `ertmp` (HEVC passthrough, no GPU) **only when**
  `twitch_hevc_eligible && twitch_use_passthrough`; otherwise it falls to the H.264 transcode
  group (needs a GPU). This is mirrored in `provision/route.ts` so the GPU-vs-hub decision can't drift.
- ⚠️ eligible-Twitch eRTMP is **provisional** until validated on a real Affiliate/Partner account.
  For *this* test keep Twitch off so a non-eligible Twitch can't pull in a GPU.

---

## 7. Rollback / safety
- Instant rollback: `SLIMCAST_VPS_HUB=false` → provision returns to the Vast all-in-one path.
- Reaper + heartbeat sweep run in both modes, so any test hub/IP is always cleaned up.
- Billing is OFF; idle / max-session / orphan self-destruct stay on (rogue-cost safety).
