# Multistream Relay (HEVC → H.264) for RunPod

Take HEVC from your Mac mini M4's hardware encoder, send it once to a rented
RTX 4060 on RunPod, and fan it out:

- **YouTube** — original HEVC, passed through with no re-encode (HLS ingest)
- **Twitch** — transcoded to H.264 (NVENC)
- **Kick** — transcoded to H.264 (NVENC)

Everything is controlled from a small web panel that you can run **as a dock
inside OBS**. See `PLAN.md` for the full architecture and the reasoning behind
each choice.

> **Run this within each platform's terms.** Kick allows simulcasting but pays a
> reduced rate when you aren't exclusive — use Kick's official *Multistream*
> toggle for full revenue eligibility. This tool does not hide simulcasting.

---

## Files

| File | What it is |
|---|---|
| `PLAN.md` | Architecture, tuning, OBS settings, caveats |
| `supervisor.py` | Builds + supervises one FFmpeg process per platform |
| `static/index.html` | The control-panel UI |
| `config.example.json` | Starter config; copied to `config.json` on first run |
| `Dockerfile` / `docker-compose.yml` | Deployment |

---

## 1. Deploy on RunPod

1. Create a **Secure Cloud** pod with an **RTX 4060** (stable public IP).
2. In the template, **Expose TCP Ports**: `1935` (ingest) and `8080` (panel).
3. Build & run (the pod must have the NVIDIA container runtime — RunPod does):

   ```bash
   export RELAY_PASSWORD='choose-a-strong-password'
   export RELAY_TOKEN='choose-a-long-random-token'   # for the OBS dock
   docker compose up -d --build
   ```

   Or without compose:

   ```bash
   docker build -t multistream-relay .
   docker run -d --gpus all \
     -e RELAY_PASSWORD='...' -e RELAY_TOKEN='...' \
     -p 1935:1935 -p 8080:8080 \
     -v "$PWD/config.json:/app/config.json" \
     multistream-relay
   ```

4. In **Connect → TCP Port Mapping**, note the external IP + ports RunPod
   assigned to `1935` and `8080`.

Verify NVENC is visible inside the container:

```bash
docker exec -it <container> ffmpeg -hide_banner -encoders | grep nvenc
```

---

## 2. Point OBS at the relay (Mac mini M4)

OBS **v30+** required (for enhanced-RTMP HEVC).

- **Settings → Output → Streaming**
  - Encoder: **Apple VT H265 Hardware Encoder**
  - Rate control: CBR, bitrate ~**10000–12000** kbps (fit your uplink)
  - Keyframe interval: **2 s** (must be fixed)
  - Profile: main
- **Settings → Video:** 1920×1080, 60 fps
- **Settings → Audio:** 48 kHz
- **Settings → Stream**
  - Service: **Custom…**
  - Server: `rtmp://<RUNPOD_IP>:<MAPPED_1935_PORT>/live`
  - Stream Key: `stream`

Click **Start Streaming** in OBS. OBS now uploads one HEVC feed to the pod.

---

## 3. The control panel — inside OBS

The panel sets stream keys, max bitrate, resolution and FPS per platform, and
starts/stops the pipeline. Two ways to open it:

**A) As an OBS dock (what you asked for):**

1. OBS → **Docks → Custom Browser Docks…**
2. Dock Name: `Multistream` · URL:
   `http://<RUNPOD_IP>:<MAPPED_8080_PORT>/?token=<YOUR_RELAY_TOKEN>`
3. Apply. The panel appears as a panel you can dock anywhere in OBS.

   The `?token=` is how the dock authenticates (browser docks can't show a login
   prompt). Keep that URL private — the token grants control of your stream keys.

**B) In a normal browser:** open `http://<RUNPOD_IP>:<MAPPED_8080_PORT>/` and log
in with `RELAY_USERNAME` / `RELAY_PASSWORD`.

In the panel: paste each platform's ingest URL + stream key, set bitrate/res/fps,
enable the destinations, then **Save & apply**. Per-platform status dots and a log
tail show what each output is doing.

### Auto start/stop with OBS (no Start button needed)

By default the relay stays idle and only runs while OBS is publishing:

- You hit **Start Streaming** in OBS → MediaMTX fires `runOnReady` → `hook.sh start`
  turns the transcoder on automatically.
- You hit **Stop Streaming** in OBS → `runOnNotReady` → `hook.sh stop` shuts the
  encoders down, so the GPU isn't burning data/time between streams.

**Grace period:** a stop triggered by OBS is deferred by `RELAY_STOP_GRACE`
seconds (default 20). If OBS reconnects within that window, the pending stop is
cancelled — so a brief network blip won't tear your stream down. The panel's
manual **Stop** button is immediate (no grace). Set `RELAY_STOP_GRACE=0` to
disable the delay.

The panel's manual **Start / Stop** buttons still work if you want to override.
To instead have the relay run the moment the pod boots, set `RELAY_AUTOSTART=1`.

### Getting the ingest URLs/keys

- **Twitch:** Creator Dashboard → Settings → Stream. URL `rtmp://live.twitch.tv/app`, key `live_…`
- **Kick:** Creator → Settings → Stream Key. Use the RTMPS ingest URL + key it shows.
- **YouTube:** Studio → Go Live → Stream → **create an HLS stream key**, copy the
  HLS ingestion URL into the `youtube` output's URL field (mode = passthrough).

---

## 4. Tuning for crisp high-motion FPS

Defaults are already set for quality (`p7`, `tune hq`, full-res multipass,
B-frame refs, spatial+temporal AQ, 2 s GOP). The lever that matters most is
**bitrate** — push Twitch to ~8000 and Kick higher if your channel allows. See
`PLAN.md` §4 for the full rationale and platform ceilings.

---

## Troubleshooting

- **OBS won't connect:** you're using the *mapped external* port, not 1935? Pod
  TCP port exposed? OBS is v30+ with the **H265** encoder selected?
- **YouTube rejects segments:** confirm you created an **HLS** key (not RTMP) and
  pasted the HLS URL. As a fallback, switch the youtube output to `transcode`
  mode (one dropdown) to send H.264 instead.
- **Encoder shows `error` in the panel:** open its **Logs**; usually a bad
  stream key or a bitrate the platform rejected.
- **Quality soft in fast motion:** raise that platform's bitrate; make sure the
  Mac source bitrate isn't starved by your uplink.

This relay can't be tested against live Twitch/Kick/YouTube from a dev machine —
expect to tweak bitrates and the YouTube HLS URL on your first real run.
