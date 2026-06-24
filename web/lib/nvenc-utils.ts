export interface UserOutputConfig {
  orientation: string  // 'landscape' | 'portrait'
  resolution: string   // e.g. '1080p'
  bitrate_kbps: number
  mode: string         // 'passthrough' | 'transcode'
  enabled: boolean
}

/**
 * How many simultaneous NVENC encode sessions the user's config requires.
 *
 * Grouping rule (mirrors supervisor.py plan_runners):
 *   - Platforms with the same (orientation, resolution, bitrate_kbps) are tee'd
 *     onto a single encoder → 1 session regardless of how many platforms share it.
 *   - Portrait and landscape are always separate sessions (different crop+scale).
 *   - Passthrough (YouTube HEVC copy) uses 0 NVENC sessions.
 *
 * Consumer GeForce cards (RTX 3090/4090/5090) have a 3-session hardware cap.
 * When this returns >3, the broker must skip consumer GPUs.
 */
export function requiredNvencSessions(outputs: UserOutputConfig[]): number {
  const tuples = new Set<string>()
  for (const o of outputs) {
    if (!o.enabled || o.mode === 'passthrough') continue
    tuples.add(`${o.orientation}|${o.resolution}|${o.bitrate_kbps}`)
  }
  return tuples.size
}
