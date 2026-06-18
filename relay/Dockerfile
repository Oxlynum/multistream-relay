# Multistream relay: NVENC-capable FFmpeg + MediaMTX ingest + control panel.
# Requires the NVIDIA container runtime at run time (RunPod provides this).
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ARG MEDIAMTX_VERSION=v1.9.3
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

# 1935 = RTMP ingest (expose via RunPod TCP) ; 8080 = control panel (debug)
EXPOSE 1935 8080

# agent.py is the production entrypoint.
# It handles pairing with Vercel, starting MediaMTX, and polling config.
# start.sh remains for local development / debugging.
CMD ["python3", "agent.py"]
