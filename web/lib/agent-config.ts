// Builds the output list the GPU agent consumes, shared by the agent/config
// (polled) and agent/pair (boot) routes so they never drift apart.

import { decryptSecret } from '@/lib/crypto'

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

export interface GroupBitrates {
  landscape: number
  portrait: number
}

export function buildAgentOutputs(platforms: PlatformRow[], groups?: GroupBitrates) {
  const landscapeCap = groups?.landscape ?? 6000
  const portraitCap  = groups?.portrait ?? 4000

  return platforms.map(p => {
    const orientation = p.orientation ?? 'landscape'
    // Decrypt the at-rest secret right before it goes to the agent. Legacy
    // plaintext rows pass through unchanged (see decryptSecret fallback).
    const streamKey = decryptSecret(p.stream_key_encrypted)

    // YouTube landscape → HEVC passthrough (no re-encode, best quality). The
    // source HEVC is copied straight into HLS and PUT to YouTube's HLS ingest.
    // Bitrate is irrelevant here (no encode). Portrait YouTube can't be
    // passthrough (it's the cropped 9:16 feed), so it falls through to a normal
    // transcode and joins the portrait encode group.
    if (p.platform === 'youtube' && orientation === 'landscape') {
      return {
        name: p.platform,
        url: youtubeHlsUrl(streamKey),
        key: '',
        bitrate_kbps: p.bitrate_kbps ?? defaultBitrate(p.platform),
        fps: p.fps ?? 60,
        orientation,
        mode: 'passthrough',
        enabled: p.enabled,
      }
    }

    // Transcoded outputs inherit their orientation group's bitrate cap. The
    // supervisor still floors this at each platform's hard max (e.g. TikTok
    // 4500) when it computes the shared group bitrate.
    return {
      name: p.platform,
      url: p.rtmp_url,
      key: streamKey,
      bitrate_kbps: orientation === 'portrait' ? portraitCap : landscapeCap,
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
