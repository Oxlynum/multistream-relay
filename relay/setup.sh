#!/usr/bin/env bash
# One-command installer. Re-run this after any pod restart (RunPod wipes
# everything except /workspace, so the binaries below must be reinstalled).
# It is idempotent: it skips anything already installed.
set -e
cd "$(dirname "$0")"

echo "==> System packages"
apt-get update
apt-get install -y wget xz-utils tar python3-pip unzip

# jellyfin-ffmpeg: NVENC + full CUDA filters, built to match mainstream NVIDIA
# drivers. The generic BtbN "latest" build targets bleeding-edge drivers (needs
# 610+) and fails on typical cloud GPUs (driver 550 = NVENC API 12.2). This
# version is pinned because it's verified working on driver 550.x.
JF_VER="7.1.4-3"
JF_URL="https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${JF_VER}/jellyfin-ffmpeg_${JF_VER}_portable_linux64-gpl.tar.xz"
echo "==> Installing FFmpeg (jellyfin-ffmpeg ${JF_VER})"
wget -qO /tmp/jf.tar.xz "$JF_URL"
rm -rf /opt/jffmpeg && mkdir -p /opt/jffmpeg
tar -xJf /tmp/jf.tar.xz -C /opt/jffmpeg
JF=$(dirname "$(find /opt/jffmpeg -name ffmpeg -type f | head -1)")
ln -sf "$JF/ffmpeg"  /usr/local/bin/ffmpeg
ln -sf "$JF/ffprobe" /usr/local/bin/ffprobe
rm -f /tmp/jf.tar.xz
echo "    $(ffmpeg -version | head -1)"

if ! command -v mediamtx >/dev/null 2>&1; then
  echo "==> Installing MediaMTX"
  wget -qO /tmp/mediamtx.tar.gz https://github.com/bluenviron/mediamtx/releases/download/v1.9.3/mediamtx_v1.9.3_linux_amd64.tar.gz
  tar -xzf /tmp/mediamtx.tar.gz -C /usr/local/bin mediamtx
  rm -f /tmp/mediamtx.tar.gz
else
  echo "==> MediaMTX already present, skipping"
fi

echo "==> Python deps"
pip3 install -r requirements.txt

chmod +x start.sh hook.sh run.sh 2>/dev/null || true
echo
echo "Setup complete.  Start everything with:   bash run.sh"
