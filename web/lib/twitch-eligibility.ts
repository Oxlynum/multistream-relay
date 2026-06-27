// Twitch HEVC / Enhanced Broadcasting eligibility detection.
//
// HEVC passthrough to Twitch only works for channels Twitch authorizes for the
// 2K/HEVC tier (Partners + select Affiliates). Eligibility is server-authoritative
// and bound to the channel's stream key — you can't request your way into it. The
// definitive signal is GetClientConfiguration's `encoder_configurations[0].type`:
// `*hevc*` for eligible channels, `*h264*` (and a forced 1080p downgrade) for
// everyone else. We probe at 1440p HEVC so an eligible account returns its real
// ceiling; a non-eligible account gets downgraded to 1080p H.264, which we detect.
//
// This drives both the routing (eRTMP passthrough vs H.264 transcode) and the UI
// (2K + passthrough options only surface when eligible).

// Fixed GPU identity reported to the config API — see relay/supervisor.py SPOOF_GPU.
// The GPU is unverifiable client data and irrelevant to passthrough; we only need
// the config to come back so we can read the authorized codec.
const SPOOF_GPU = {
  model: 'NVIDIA GeForce RTX 4090',
  vendor_id: 4318,
  device_id: 9860,
  dedicated_video_memory: 24 * 1024 ** 3,
  shared_system_memory: 16 * 1024 ** 3,
  driver_version: '32.0.15.6094',
}

const CONFIG_URL = 'https://ingest.twitch.tv/api/v3/GetClientConfiguration'

export interface TwitchEligibility {
  /** True if Twitch authorizes HEVC for this channel (Partner/select-Affiliate 2K tier). */
  hevcEligible: boolean
  /** The codec Twitch will actually accept, e.g. 'h264' or 'hevc'. */
  codec: string
  /** Max resolution Twitch offers this channel (height in px), e.g. 1080 or 1440. */
  maxHeight: number
  /** ISO timestamp of the check. */
  checkedAt: string
}

function buildConfigBody(streamKey: string) {
  return {
    service: 'IVS',
    schema_version: '2025-01-25',
    authentication: streamKey,
    capabilities: {
      cpu: { physical_cores: 8, logical_cores: 16, speed: 3600, name: 'Intel Core i9-13900K' },
      memory: { total: 32 * 1024 ** 3, free: 16 * 1024 ** 3 },
      gaming_features: null,
      system: {
        version: '10.0.22631', name: 'Windows', build: 22631, release: '23H2',
        revision: '', bits: 64, arm: false, armEmulation: false,
      },
      gpu: [{ ...SPOOF_GPU }],
    },
    client: { name: 'obs-studio', version: '32.0.4', supported_codecs: ['h265', 'h264'] },
    preferences: {
      vod_track_audio: false,
      composition_gpu_index: 0,
      // Probe at 1440p so an eligible account reveals its 2K HEVC ceiling.
      canvases: [{
        width: 2560, height: 1440, canvas_width: 2560, canvas_height: 1440,
        framerate: { numerator: 60, denominator: 1 },
      }],
      audio_samples_per_sec: 48000,
      audio_channels: 2,
      audio_fixed_buffering: false,
      audio_max_buffering_ms: 20,
      maximum_video_tracks: 1,
      maximum_aggregate_bitrate: 12_000_000,
    },
  }
}

/**
 * Ask Twitch what codec/resolution it authorizes for this channel. Network/parse
 * failures resolve to not-eligible (safe default → H.264 transcode path).
 */
export async function checkTwitchHevcEligibility(streamKey: string): Promise<TwitchEligibility> {
  const checkedAt = new Date().toISOString()
  const notEligible: TwitchEligibility = { hevcEligible: false, codec: 'h264', maxHeight: 1080, checkedAt }
  if (!streamKey?.trim()) return notEligible

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(CONFIG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildConfigBody(streamKey)),
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return notEligible
    const cfg = await res.json() as {
      encoder_configurations?: Array<{ type?: string; width?: number; height?: number }>
      status?: { result?: string }
    }
    if (cfg.status?.result === 'error') return notEligible

    const enc = cfg.encoder_configurations ?? []
    if (enc.length === 0) return notEligible
    // Twitch returns the highest-quality track first.
    const type = (enc[0].type ?? '').toLowerCase()
    const codec = type.includes('hevc') || type.includes('h265') ? 'hevc'
      : type.includes('av1') ? 'av1'
      : 'h264'
    const maxHeight = Math.max(...enc.map(e => e.height ?? 0), 0) || 1080
    return { hevcEligible: codec === 'hevc', codec, maxHeight, checkedAt }
  } catch {
    return notEligible
  } finally {
    clearTimeout(timer)
  }
}
