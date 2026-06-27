# Multistream relay: NVENC-capable FFmpeg + MediaMTX ingest + control panel.
# Requires the NVIDIA container runtime at run time (the host provides the driver).
#
# Base is the SMALL `-base` CUDA image (~150MB), NOT `-runtime` (~1.37GB). The
# CUDA toolkit runtime (libcudart/libnpp/cuBLAS) is deliberately excluded: the
# relay's entire GPU surface is driver-level — NVENC encode (libnvidia-encode),
# NVDEC decode (libnvcuvid), and `-hwaccel cuda` (libcuda, the CUDA Driver API) —
# all mounted from the host by the NVIDIA container runtime, never shipped here.
# See the dependency audit; nothing in the pipeline calls the CUDA runtime API.
FROM nvidia/cuda:12.4.1-base-ubuntu22.04

# Declare the GPU + driver capabilities the relay needs, so it works on ANY host
# regardless of the runtime's defaults. The `nvidia/cuda` base defaults to
# `compute,utility` which OMITS `video` — without `video`, NVENC/NVDEC libs aren't
# mounted and every transcode fails. RunPod silently sets `all`; other hosts
# (e.g. Vast) may not, so we set it explicitly:
#   compute = libcuda (-hwaccel cuda) · video = NVENC/NVDEC · utility = nvidia-smi
ENV NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

ARG MEDIAMTX_VERSION=v1.19.1
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip wget xz-utils ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*

# --- FFmpeg (jellyfin-ffmpeg: NVENC + CUDA filters, matches mainstream drivers) ---
# Pinned: the BtbN "latest" build needs NVIDIA driver 610+; typical cloud GPUs
# run driver ~550 (NVENC API 12.2). This version is verified on driver 550.x.
ARG JF_VER=7.1.4-3
RUN wget -qO /tmp/jf.tar.xz \
      https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${JF_VER}/jellyfin-ffmpeg_${JF_VER}_portable_linux64-gpl.tar.xz \
    && mkdir -p /opt/jffmpeg && tar -xJf /tmp/jf.tar.xz -C /opt/jffmpeg \
    && JF=$(dirname "$(find /opt/jffmpeg -name ffmpeg -type f | head -1)") \
    && ln -sf "$JF/ffmpeg"  /usr/local/bin/ffmpeg \
    && ln -sf "$JF/ffprobe" /usr/local/bin/ffprobe \
    && rm -f /tmp/jf.tar.xz

# --- MediaMTX ingest server -------------------------------------------------
RUN wget -qO /tmp/mediamtx.tar.gz \
      https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz \
    && tar -xzf /tmp/mediamtx.tar.gz -C /usr/local/bin mediamtx \
    && rm -f /tmp/mediamtx.tar.gz

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .
RUN chmod +x start.sh hook.sh 2>/dev/null || true

# 1935/tcp = RTMP readiness beacon (broker's MediaMTX-liveness probe; OBS does NOT
#   publish here) ; 8080 = control panel (debug)
# 8890/udp = SRT ingest — the ONLY OBS→pod transport ; 8889/udp = UDP echo
#   (broker's per-host UDP-forwarding + outbound-to-platforms check).
# SRT/UDP is mandatory now: every provider must be UDP-capable (Vast today; RunPod
# was dropped — its pods are TCP-only). The host maps these EXPOSE'd ports — Vast
# needs explicit `-p HOST:CONTAINER/udp` flags for the UDP ones (see
# providers/vast.ts); TCP comes free from EXPOSE. OBS publishes
# srt://<pod>:<mapped>?streamid=publish:<ingest-key>, gated by the per-pod ingest
# key. The 8889 echo lets the broker verify the host forwards UDP + can reach the
# platforms before committing.
EXPOSE 1935 8080 8888 8890/udp 8889/udp

# agent.py is the production entrypoint.
# It handles pairing with Vercel, starting MediaMTX, and polling config.
# start.sh remains for local development / debugging.
CMD ["python3", "agent.py"]
