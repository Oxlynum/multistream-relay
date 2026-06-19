// Builds the output list the GPU agent consumes, shared by the agent/config
// (polled) and agent/pair (boot) routes so they never drift apart.

export interface PlatformRow {
  platform: string
  rtmp_url: string
  stream_key_encrypted: string
  bitrate_kbps: number | null
  fps: number | null
  orientation: string | null
  enabled: boolean
}

// YouTube ingests HEVC only over HLS (its RTMP endpoint is H.264-only). The
// `cid` parameter is the user's normal stream key — same one they'd use for
// RTMP — so we can construct the HLS ingest URL without asking for anything new.
export function youtubeHlsUrl(streamKey: string): string {
  return `https://a.upload.youtube.com/http_upload_hls?cid=${encodeURIComponent(streamKey)}&copy=0&file=stream.m3u8`
}

export function buildAgentOutputs(platforms: PlatformRow[]) {
  return platforms.map(p => {
    const orientation = p.orientation ?? 'landscape'

    // YouTube landscape → HEVC passthrough (no re-encode, best quality). The
    // source HEVC is copied straight into HLS and PUT to YouTube's HLS ingest.
    // Portrait YouTube can't be passthrough (it's the cropped 9:16 feed), so it
    // falls through to a normal transcode and joins the portrait encode group.
    if (p.platform === 'youtube' && orientation === 'landscape') {
      return {
        name: p.platform,
        url: youtubeHlsUrl(p.stream_key_encrypted),
        key: '',
        bitrate_kbps: p.bitrate_kbps ?? defaultBitrate(p.platform),
        fps: p.fps ?? 60,
        orientation,
        mode: 'passthrough',
        enabled: p.enabled,
      }
    }

    return {
      name: p.platform,
      url: p.rtmp_url,
      key: p.stream_key_encrypted,
      bitrate_kbps: p.bitrate_kbps ?? defaultBitrate(p.platform),
      fps: p.fps ?? 60,
      orientation,
      mode: 'transcode',
      enabled: p.enabled,
    }
  })
}

export function defaultBitrate(platform: string): number {
  const defaults: Record<string, number> = {
    twitch: 6000, kick: 6000, youtube: 6000, tiktok: 4000,
  }
  return defaults[platform] ?? 6000
}
