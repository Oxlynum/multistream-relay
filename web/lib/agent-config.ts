// Builds the output list the GPU agent consumes, shared by the agent/config
// (polled) and agent/pair (boot) routes so they never drift apart.

import { decryptSecret } from '@/lib/crypto'
import type { OutputSettingsMap } from '@/lib/billing'

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

// Legacy group bitrates kept for backward compat with the /api/encode route.
// The new per-output settings take precedence when present.
export interface GroupBitrates {
  landscape: number
  portrait: number
}

const PLATFORM_BITRATE_DEFAULTS: Record<string, number> = {
  twitch: 6000, kick: 6000, youtube: 6000, tiktok: 4000,
}

export function defaultBitrate(platform: string): number {
  return PLATFORM_BITRATE_DEFAULTS[platform] ?? 6000
}

const PLATFORM_BITRATE_LIMITS: Record<string, { min: number; max: number }> = {
  twitch:  { min: 2500, max: 8000 },
  kick:    { min: 2500, max: 8000 },
  youtube: { min: 2500, max: 8000 },
  tiktok:  { min: 1000, max: 4500 },
}

export function bitrateRange(platform: string): { min: number; max: number } {
  return PLATFORM_BITRATE_LIMITS[platform] ?? { min: 1000, max: 8000 }
}

export function buildAgentOutputs(
  platforms: PlatformRow[],
  outputSettings?: OutputSettingsMap,
  groups?: GroupBitrates,
) {
  const landscapeGroupCap = groups?.landscape ?? 6000
  const portraitGroupCap  = groups?.portrait ?? 4000

  return platforms.map(p => {
    const orientation = p.orientation ?? 'landscape'
    const streamKey = decryptSecret(p.stream_key_encrypted)

    // Per-output settings (resolution + bitrate) override the group defaults.
    const perOutput = outputSettings?.[p.platform]
    const resolution = perOutput?.resolution ?? '1080p'

    // YouTube landscape → HEVC passthrough via HLS (YouTube RTMP endpoint is H.264-only).
    if (p.platform === 'youtube' && orientation === 'landscape') {
      return {
        name: p.platform,
        url: youtubeHlsUrl(streamKey),
        key: '',
        bitrate_kbps: perOutput?.bitrate_kbps ?? (p.bitrate_kbps ?? defaultBitrate(p.platform)),
        fps: p.fps ?? 60,
        orientation,
        mode: 'passthrough',
        resolution,
        enabled: p.enabled,
      }
    }


    // Per-output bitrate wins; fall back to group cap, then platform default.
    const bitrate = perOutput?.bitrate_kbps
      ?? (orientation === 'portrait' ? portraitGroupCap : landscapeGroupCap)

    return {
      name: p.platform,
      url: p.rtmp_url,
      key: streamKey,
      bitrate_kbps: bitrate,
      fps: p.fps ?? 60,
      orientation,
      mode: 'transcode',
      resolution,
      enabled: p.enabled,
    }
  })
}
