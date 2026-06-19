// Pricing model: pay-per-use streaming credits, stored in seconds.
//   1 token = 1 hour = 3600 credit-seconds = $2.00
//
// What's included in the base 1 token/hr:
//   - YouTube HEVC passthrough (no encode — always free)
//   - the first transcoded platform
// Each ADDITIONAL transcoded platform adds 0.2 token/hr.
//
// Because 1 token/hr == 1 credit-second per real second, the burn rate in
// tokens/hr is numerically identical to the credits-per-second deduction rate.

export interface OutputStatus {
  name: string
  state: string
  mode?: string
  platforms?: string[]
}

/** Count billable transcoded platforms currently running (passthrough is free). */
export function transcodeCount(outputs: OutputStatus[]): number {
  return outputs
    .filter(o => o.state === 'running' && o.mode !== 'passthrough')
    .reduce((sum, o) => sum + (o.platforms?.length ?? 1), 0)
}

/**
 * Burn rate in tokens/hr (== credit-seconds per second).
 *   not streaming        → 0
 *   streaming, passthrough-only or 1 transcode → 1.0 (base)
 *   each transcode beyond the first → +0.2
 */
export function burnRatePerSec(transcodes: number, streaming: boolean): number {
  if (!streaming) return 0
  return 1 + 0.2 * Math.max(0, transcodes - 1)
}

/** Seconds of real streaming time left at the current burn rate. */
export function secondsRemaining(creditsSeconds: number, burnRate: number): number {
  if (burnRate <= 0) return creditsSeconds
  return Math.floor(creditsSeconds / burnRate)
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}
