# macvpc.md — Mac vs. PC (Windows): the cross-platform reality

**Status:** LIVING TRACKER — created 2026-06-30. Owns the "is SlimCast really a Mac *and* PC
app?" question end-to-end. Read alongside `CLAUDE.md` (§ OBS plugin) and `slimcast-obs/BUILD.md`.

---

## TL;DR

SlimCast began as a personal tool for the author's **Mac mini M4** (OBS + Apple VideoToolbox
HEVC). It is now positioned as a **Mac and PC** product that accepts **any HEVC-capable hardware
encoder** — Apple VideoToolbox on macOS; **NVENC (NVIDIA) / AMF (AMD) / QSV (Intel)** on Windows.

On the **backend** that is already true: the hub, the GPU, the broker, and the web app never care
what encoded the source — they ingest HEVC-over-SRT from anything. The gap is the **OBS plugin**.
Its *core logic* is cross-platform (encoder detection, restart, help copy, a real Windows CMake
preset all exist), but the plugin has **never been built or run on Windows**, and at least one
macOS-only code path means it almost certainly **will not compile under MSVC as-is**.

**Today: Mac = shipping. Windows = aspirational until a tested build exists.** This doc is the
single tracker for closing that gap.

---

## Why the backend is already platform-agnostic

- OBS → hub ingest is **HEVC over SRT** — a bitstream transport. The hub/GPU decode HEVC; they
  neither know nor care whether Apple VT, NVENC, AMF, or QSV produced it.
- The only place "Apple" legitimately appears in the data plane is a **technical note**: Apple
  VideoToolbox emits *temporal-layered* HEVC, which is why the internal loopback uses SRT, not RTSP
  (RTSP mangles temporal layers). NVENC/AMF/QSV HEVC with a B-pyramid hit the same path — the note
  generalizes to "temporal-layered HEVC from any hardware encoder."

---

## What's already cross-platform in the plugin (the good news)

- **Encoder auto-detection is encoder-agnostic** — `pickHevcEncoder()`
  (`slimcast-obs/src/relay-dock.cpp:89`) enumerates every registered HEVC encoder and, on
  non-Apple, prefers: `obs_nvenc_hevc_tex → jim_hevc_nvenc → obs_nvenc_hevc_cuda →
  ffmpeg_hevc_nvenc → obs_qsv11_hevc → h265_texture_amf → VAAPI`. Apple VT is just the macOS branch.
- **`restartObs()`** (`relay-dock.cpp:134`) is `#ifdef`-guarded for macOS / `_WIN32` / Linux.
- **Cross-platform help copy already exists** — `relay-dock.cpp:523` ("Apple VideoToolbox on Mac,
  NVIDIA / AMD / Intel on PC") and `:1536` ("SlimCast needs Apple VideoToolbox (Mac) or an
  NVIDIA / AMD / Intel …").
- **CMake has a real Windows preset** (`windows-x64`, VS 2022) and `BUILD.md` documents the Windows
  build + the NSIS `.exe`.

---

## The real blockers (why Windows isn't proven)

### 1. The plugin CI never actually runs — there are no automated plugin builds at all
`slimcast-obs/.github/workflows/release.yml` defines `build-macos` **and** `build-windows`
(.pkg / .exe). **But GitHub Actions only runs workflows in the repo-root `.github/workflows/`.**
This repo's root holds only `relay-docker.yml`; the plugin workflow is nested one level down in
`slimcast-obs/.github/workflows/`, so **GitHub never fires it.** `gh run list` confirms it — every
CI run is "Build & Push Relay Image"; there has **never** been a macOS *or* Windows plugin build in
CI. The only plugin artifacts that exist are hand-built macOS `.pkg`s committed to the repo.
- **Consequence:** the "CI builds .pkg/.exe" claim is currently false, and the Windows compile has
  never been exercised by anything.
- **Fix:** move `release.yml` to the repo-root `.github/workflows/` (scope it with
  `paths: ['slimcast-obs/**']` so it only fires on plugin changes). Only then does the Windows
  build even get a chance to compile.

### 2. `plugin-main.cpp` has an unconditional POSIX-only path → won't compile under MSVC
`registerBundledTlsBackend()` (`slimcast-obs/src/plugin-main.cpp:47-60`, plus `#include <dlfcn.h>`
at line 7) uses `dladdr()` / `Dl_info` and walks a macOS `.app` bundle
(`…/Contents/MacOS` → `…/Contents/PlugIns/tls`). `dlfcn.h` / `dladdr` are **POSIX-only**; the MSVC
toolchain used by the `windows-x64` preset has no `dlfcn.h`. The include is **unconditional** and
the function is called unconditionally from `obs_module_load()`, so the file almost certainly
**fails to compile on Windows.**
- **What it does:** OBS.app on macOS ships QtNetwork but no Qt TLS backend, so the plugin bundles
  one and points Qt's library path at it (needed for HTTPS to slimcast.com). **Windows OBS ships
  its own Qt TLS backend**, so this whole mechanism should be a **no-op on Windows.**
- **Fix:** wrap the include *and* the function body in `#ifdef __APPLE__` (empty no-op elsewhere).
  Low-risk change, but **must be verified by an actual Windows build** — this is the obvious
  blocker, not necessarily the only one.

### 3. Mac-only encoder instruction shown to PC users
`relay-dock.cpp:1058` unconditionally tells the user *"OBS Settings → Output → Streaming →
Encoder → **Apple VT H265**"* when a non-HEVC encoder is detected. On Windows that's wrong — they
need NVIDIA/AMD/Intel HEVC.
- **Fix:** make the string platform-aware (`#ifdef __APPLE__` → "Apple VT H265"; else →
  "NVIDIA / AMD / Intel HEVC (H.265)"). Trivial and safe.

### 4. Live-bitrate throttle honoring is unverified off-Apple (+ a testing artifact)
`relay-dock.cpp:1666-1667`: *"Verify on the M4 that VT HEVC honours it live."* The live
ingest-throttle lever (`obs_encoder_update()` of `AverageBitRate` / `bitrate`) was only ever
verified against Apple VT. NVENC/AMF/QSV expose the live-bitrate knob under different keys and may
honor mid-stream changes differently.
- **Action:** verify the throttle lever on at least one NVENC build; generalize the comment.

### 5. Version drift
`BUILD.md` + the committed `.pkg` say **2.0.0**; `CLAUDE.md` calls the plugin **v2.1.0**. Pick one
and make them agree.

---

## Honest status

| Surface | macOS | Windows |
|---|---|---|
| Backend (hub / GPU / broker / web) | ✅ works, encoder-agnostic | ✅ works, encoder-agnostic |
| Plugin: encoder detection | ✅ | ✅ (code path exists, unbuilt) |
| Plugin: compiles | ✅ (hand-built `.pkg`) | ❌ likely no (`dlfcn`) |
| Plugin: CI build | ❌ never runs (misplaced workflow) | ❌ never runs |
| Plugin: run / stream verified | ✅ | ❌ never |

---

## Remediation plan (the follow-up "Windows enablement" project)

Ordered; each step gates the next:

1. **Move `release.yml` → repo-root `.github/workflows/`** (path-scoped to `slimcast-obs/**`). Now
   CI exercises both builds on every plugin change.
2. **Guard the macOS-only TLS/`dlfcn` code** (`#ifdef __APPLE__`, no-op on Windows). Re-run CI;
   iterate on any further MSVC compile errors it surfaces.
3. **Platform-aware encoder tooltip** (`:1058`) + generalize the M4 comment (`:1667`).
4. **Get a green Windows `.exe` in CI**, then **install it on a real Windows box**: dock loads,
   HTTPS to slimcast.com works (TLS backend present), Start Streaming provisions, and an
   **NVENC / QSV / AMF HEVC** source ingests and goes live end-to-end.
5. **Verify the live-bitrate throttle lever** on a non-Apple encoder.
6. Reconcile the version number; correct `CLAUDE.md`'s plugin/CI claims + `BUILD.md`.

---

## Decision log

- **2026-06-30:** During the docs / Mac→PC cleanup pass, the plugin **code** fixes (blockers #2–#4)
  were **deferred** to a dedicated Windows-enablement pass rather than edited blind on a Mac (a
  Windows build can't be verified from here). This doc is the tracker. In that same pass, the `.md`
  docs and the **non-plugin** code comments were generalized from Mac-mini/Apple-exclusive framing
  to "any HEVC-capable encoder (Apple VT on Mac; NVENC / AMF / QSV on PC)."
