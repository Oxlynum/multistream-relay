# GEMINI.md

This file provides guidance to Gemini (Antigravity) when working with code in this repository.

---

## ⚡ CLI TOOLS AVAILABLE IN THIS SESSION

| CLI | What it covers |
|-----|----------------|
| `vastai` | List/destroy/SSH into running Vast.ai GPU instances (`vastai show instances-v1 --raw`, `vastai logs <id>`, `vastai destroy instance <id> --yes`) |
| `gh` | GitHub — PRs, issues, CI status, release tags (`gh run list`, `gh pr create`, `gh release view`) |
| `supabase` | DB migrations, inspect tables, run SQL (`supabase db diff`, `supabase migration new`, `supabase db push`) |
| `vercel` | Deploy, logs, env vars (`vercel logs --environment=production --since=10m -x`, `vercel env pull`, `vercel --prod`) |

**Credentials & Isolation:** CLI credentials auto-load when you directory-hop using standard tooling. Tokens live in `.envrc` (gitignored).
Linked accounts: GitHub `Oxlynum`, Vercel `oxlynum-5723`, Supabase `Oxlynum's Org`.

---

## 🚀 PROJECT OVERVIEW & STATUS

**SlimCast** is a consumer multistreaming SaaS. OBS pushes one HEVC stream (over SRT/UDP) from a Mac mini M4 to a cloud GPU; the GPU transcodes once per orientation and fans out to Twitch, Kick, YouTube, TikTok. 

- **Current Status:** Ingest is SRT-only (UDP). RunPod is removed due to TCP-only limitations. Active provider is Vast.ai (`SLIMCAST_BROKER_V2=true` enabled). Vultr integration is planned.
- **Vast GPU Setup:** Ingests SRT on port `8890` (passphrase authenticated, routed by stream ID). Output streaming/transcoding starts on ready signals.
- **Next.js 16 Web App:** Located in `web/`, auth gate is in `web/proxy.ts`.
- **OBS Plugin:** Located in `slimcast-obs/` (C++ v2.1.0 plugin for macOS/Windows).

---

## 📂 REPOSITORY LAYOUT

- [relay/](file:///Users/danielaltom/desktop/claude/projects/slimcast/relay) — GPU Docker image (`supervisor.py`, `agent.py`, `app.py`, MediaMTX, `hook.sh`)
- [web/](file:///Users/danielaltom/desktop/claude/projects/slimcast/web) — Next.js 16 (Auth, dashboard, billing, broker, OBS dock. Supabase + Stripe)
- [slimcast-obs/](file:///Users/danielaltom/desktop/claude/projects/slimcast/slimcast-obs) — C++ OBS plugin v2.1.0
- [docs/](file:///Users/danielaltom/desktop/claude/projects/slimcast/docs) — Architecture notes (may be stale)

---

## 🛠 COMMON COMMANDS

### Next.js Web App (`web/`)
```bash
cd web
npm run dev
npx tsc --noEmit          # Pre-push compilation gate
vercel --prod             # Deploy to production (run from repo root)
```

### OBS Plugin (`slimcast-obs/`)
```bash
cd slimcast-obs
cmake --preset macos-arm64
cmake --build --preset macos-arm64
cmake --install build/macos-arm64 --prefix "$HOME/Library/Application Support/obs-studio/plugins"
```

### Relay Docker Image (`relay/`)
```bash
cd relay
docker compose up --build   # Local testing (requires RELAY_PASSWORD env)
```

---

## 📐 CORE ARCHITECTURE GUIDELINES

1. **SRT Ingest Only (UDP):** OBS publishes via SRT (`srt://<pod>:<port>?streamid=publish:<key>`). RTMP on port `1935` is only used as a TCP readiness beacon for serverless probing.
2. **Loopback Mechanism:** MediaMTX runs SRT on `:8890`. FFmpeg reads loopback (`srt://127.0.0.1:8890?streamid=read:<key>`). RTSP is not used because it mangles Apple's temporal-layered HEVC.
3. **GPU Codecs:** Use NVDEC decode and NVENC H.264 encode. CPU is used only for portrait scaling/cropping. YouTube landscape uses `-c copy` (HEVC passthrough).
4. **Broker v2 Mechanism:** Provisions N=2 pods in parallel (`startProvisionRace()`). Returns 200 in ~5 seconds and waits for the winner pod to report `/api/agent/ready`.
5. **Hysteresis Budget Throttle:** `relay/budget.py` controls real-time egress/ingress costs by degrading transcode quality/resolution or source ingest bitrate if the cost ceiling ($1.00 - $1.50/hr) is exceeded.
6. **Defense-in-Depth Pod Safety:** Automated heartbeats self-destruct pods if credits run out, if the pod is idle for >5 min, or if the session exceeds 12h. Daily reaper cron handles orphaned instances.

---

## ✍️ GEMINI WORKING CONVENTIONS

- **Verify before destructive actions:** Always request confirmation before tearing down infrastructure, force-pushing, or deleting DB contents.
- **Symbol & File Linking:** You **must** create clickable links for all files, directories, and code symbols (classes, types, functions) using GitHub-style markdown links with the `file://` scheme.
- **Update GEMINI.md / CLAUDE.md:** Keep these files updated whenever key architecture assumptions, schemas, or dependencies change.
- **Verify types:** Run `npx tsc --noEmit` in `web/` before declaring code changes complete.
