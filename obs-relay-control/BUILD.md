# Building obs-relay-control

## Prerequisites

### macOS (M4)

1. **Xcode Command Line Tools**
   ```bash
   xcode-select --install
   ```

2. **CMake** (≥ 3.22)
   ```bash
   brew install cmake
   ```

3. **OBS Studio** — download and install the `.dmg` from https://obsproject.com/download
   The build system finds Qt6 and the OBS SDK headers inside `/Applications/OBS.app`
   automatically. No separate Qt or OBS dev package is needed.

### Windows (64-bit)

1. Install **Visual Studio 2022** with C++ desktop workload
2. Install **CMake** ≥ 3.22 (bundled with VS or from cmake.org)
3. Install **OBS Studio** to `C:\Program Files\obs-studio`
   — the OBS installer includes the SDK headers and import libraries.

---

## Build

### macOS

```bash
cd obs-relay-control
cmake -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build
cmake --install build
```

This installs the plugin to:
```
~/Library/Application Support/obs-studio/plugins/obs-relay-control/
```

Restart OBS — **Docks → Relay Control** will appear in the menu.

> **Tip:** if CMake can't find OBS, pass the explicit path:
> ```bash
> cmake -B build -DOBS_SDK_PATH=/Applications/OBS.app/Contents
> ```

### Windows (Developer PowerShell)

```bat
cd obs-relay-control
cmake -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build --config RelWithDebInfo
cmake --install build --config RelWithDebInfo
```

Restart OBS. The plugin appears under **Docks → Relay Control**.

---

## Using the plugin

### 1 — Server tab

| Field | What to enter |
|---|---|
| Provider | Pick your GPU cloud. Ports auto-fill. |
| Server IP | Public IP of your relay server |
| Ingest port | Where OBS streams to (auto-filled per provider) |
| API port | Relay control panel port (default 8080) |
| Auth token | Value of `RELAY_TOKEN` / `RELAY_PASSWORD` on the server |

Click **Apply & Set OBS Stream URL**. This:
- Configures OBS's "Custom" stream server URL to point at your relay
- Tests connectivity to the relay API
- Pulls existing config (stream keys) from the relay

### 2 — Platforms tab

Enter stream keys and bitrates per platform. Click **Save & Push to Relay**
to store them in the relay's `config.json`.

- **Twitch / Kick**: transcode mode (H.264 NVENC on the GPU)
- **YouTube**: passthrough mode (HEVC copied directly into HLS, zero re-encode)

### 3 — Start streaming

Hit OBS's **Start Streaming** button as normal. With **Auto-control** checked,
the relay starts automatically when OBS connects and stops (with a 20-second grace
period) when OBS disconnects — no manual Start/Stop needed.

The **Status** tab shows live state (`running` / `restarting` / `error`) per output
with restart counts and a **Logs** button that tails the last 250 lines of each
FFmpeg process.

---

## Provider notes

| Provider | Protocol | Notes |
|---|---|---|
| RunPod | RTMP (TCP) | UDP blocked; use the mapped external port from Connect tab |
| Vultr | SRT (UDP) | Open UDP port 8890 in the Firewall Group |
| DigitalOcean | SRT (UDP) | Open UDP port in Droplet firewall |
| Paperspace | SRT (UDP) | Open UDP 8890 in machine firewall |
| Hetzner | SRT (UDP) | Good EU option |
| AWS EC2 | SRT (UDP) | Add UDP inbound rule to Security Group |
| Lambda Labs | SRT (UDP) | Good A10 availability |
| CoreWeave | SRT (UDP) | L40 / A100 options |
| Custom | RTMP | Edit URL template manually |

SRT providers give better resilience on weak or lossy uplinks compared to RTMP.
