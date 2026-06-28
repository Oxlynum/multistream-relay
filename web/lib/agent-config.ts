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
  // Twitch-only: HEVC/Enhanced-Broadcasting eligibility + the user's passthrough
  // choice. eRTMP passthrough is used only when both are true; otherwise Twitch
  // falls through to the H.264 transcode path. Undefined for non-Twitch rows.
  twitch_hevc_eligible?: boolean | null
  twitch_use_passthrough?: boolean | null
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

// Single source of truth for which delivery path a platform takes. Used by
// buildAgentOutputs AND the provision route (so the GPU-vs-VPS decision can't drift
// from what the agent actually does — landmine #10):
//   passthrough = YouTube landscape (HEVC over HLS, `-c copy`, no GPU)
//   ertmp       = Twitch landscape, HEVC-eligible + opted in (eRTMP `-c copy`, no GPU)
//   transcode   = everything else (NVENC re-encode, needs a GPU)
export function classifyMode(
  platform: string,
  orientation: string,
  twitchHevcEligible?: boolean | null,
  twitchUsePassthrough?: boolean | null,
): 'passthrough' | 'ertmp' | 'transcode' {
  if (platform === 'youtube' && orientation === 'landscape') return 'passthrough'
  if (
    platform === 'twitch' && orientation === 'landscape' &&
    twitchHevcEligible && (twitchUsePassthrough ?? true)
  ) return 'ertmp'
  return 'transcode'
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

    const mode = classifyMode(p.platform, orientation, p.twitch_hevc_eligible, p.twitch_use_passthrough)

    // YouTube landscape → HEVC passthrough via HLS (YouTube RTMP endpoint is H.264-only).
    if (mode === 'passthrough') {
      return {
        name: p.platform,
        url: youtubeHlsUrl(streamKey),
        key: '',
        bitrate_kbps: perOutput?.bitrate_kbps ?? (p.bitrate_kbps ?? defaultBitrate(p.platform)),
        fps: p.fps ?? 60,
        orientation,
        mode,
        resolution,
        enabled: p.enabled,
      }
    }

    // Twitch landscape → HEVC passthrough via Enhanced RTMP (eRTMP), but ONLY for
    // channels Twitch authorizes for HEVC (Partner/select-Affiliate 2K tier) and
    // when the user has opted into passthrough (classifyMode gates this). Twitch
    // rejects HEVC from non-eligible channels (negotiates H.264, drops ~2s in), so
    // everyone else falls through to the H.264 transcode path below. eRTMP skips the
    // NVENC encode entirely — better quality, no GPU encode cost.
    if (mode === 'ertmp') {
      return {
        name: p.platform,
        url: 'rtmps://ingest.global-contribute.live-video.net:443/app',
        key: streamKey,
        bitrate_kbps: perOutput?.bitrate_kbps ?? (p.bitrate_kbps ?? defaultBitrate(p.platform)),
        fps: p.fps ?? 60,
        orientation,
        mode,
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
      mode,
      resolution,
      enabled: p.enabled,
    }
  })
}

// VPS-as-the-Hub: an output is GPU-free iff its mode is passthrough (YouTube HLS
// `-c copy`) or ertmp (eligible-Twitch HEVC `-c copy`). 'transcode' needs NVENC.
export type AgentOutput = ReturnType<typeof buildAgentOutputs>[number]

export function isPassthroughMode(mode: string): boolean {
  return mode === 'passthrough' || mode === 'ertmp'
}

// True iff any ENABLED output needs a GPU (mode==='transcode'). Used by the broker
// to decide VPS-only (passthrough) vs VPS+GPU (Phase 2). Structural input so both
// AgentOutput[] and the provision route's UserOutputConfig[] qualify. Do NOT reuse
// requiredNvencSessions() for this intent — same idea, but keep them separate.
export function needsTranscode(outputs: Array<{ enabled: boolean; mode: string }>): boolean {
  return outputs.some(o => o.enabled && o.mode === 'transcode')
}

// The VPS hub runs ONLY the GPU-free outputs. Thin filter over buildAgentOutputs so
// the per-platform routing (YouTube HLS, Twitch eligibility gate) never forks.
export function buildVpsConfig(
  platforms: PlatformRow[],
  outputSettings?: OutputSettingsMap,
  groups?: GroupBitrates,
): AgentOutput[] {
  return buildAgentOutputs(platforms, outputSettings, groups).filter(o => isPassthroughMode(o.mode))
}

// ── GPU backend config (Phase 2) ─────────────────────────────────────────────
// The GPU encodes ONCE per orientation (architecture #7), then returns one stream
// per orientation to the VPS. So the GPU only needs the per-orientation ENCODE specs
// — never a platform name, url, or key. KEY-FREE BY CONSTRUCTION: this builds from
// the raw platform rows directly and NEVER calls decryptSecret/buildAgentOutputs
// (landmine #2 — keys must never reach the GPU). The VPS holds the keys and does the
// per-platform tee fan-out of the GPU's return.
export interface GpuGroupSpec {
  orientation: 'landscape' | 'portrait'
  resolution: string
  fps: number
  bitrate_kbps: number
}

export function buildGpuConfig(
  platforms: PlatformRow[],
  outputSettings?: OutputSettingsMap,
  groups?: GroupBitrates,
): GpuGroupSpec[] {
  const cap = { landscape: groups?.landscape ?? 6000, portrait: groups?.portrait ?? 4000 }
  const transcode = platforms.filter(p =>
    p.enabled &&
    classifyMode(p.platform, p.orientation ?? 'landscape', p.twitch_hevc_eligible, p.twitch_use_passthrough) === 'transcode',
  )
  const resRank = (r?: string) => (r === '1440p' ? 3 : r === '1080p' ? 2 : r === '720p' ? 1 : 2)
  const specs: GpuGroupSpec[] = []
  for (const orientation of ['landscape', 'portrait'] as const) {
    const rows = transcode.filter(p => (p.orientation === 'portrait' ? 'portrait' : 'landscape') === orientation)
    if (rows.length === 0) continue
    // A tee group shares one encode: bitrate = the weakest platform (group min),
    // resolution = the most restrictive (smallest), fps = the smallest.
    const bitrate = Math.min(
      ...rows.map(p => outputSettings?.[p.platform]?.bitrate_kbps ?? p.bitrate_kbps ?? cap[orientation]),
      cap[orientation],
    )
    const resolution = rows
      .map(p => outputSettings?.[p.platform]?.resolution ?? '1080p')
      .reduce((min, r) => (resRank(r) < resRank(min) ? r : min), '1440p')
    const fps = Math.min(...rows.map(p => p.fps ?? 60))
    specs.push({ orientation, resolution, fps, bitrate_kbps: bitrate })
  }
  return specs
}
