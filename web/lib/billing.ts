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

/**
 * Credit a user for a Stripe payment exactly once. Idempotent on paymentId via
 * a single-transaction Postgres function (credit_payment_once): inserts a
 * credited_payments row + bumps the balance together, deduped by PK. Safe to
 * call from both the webhook and the auto-refill path for the same payment.
 * Returns true if it credited now, false if already credited.
 */
export async function creditPaymentOnce(
  paymentId: string,
  userId: string,
  seconds: number,
): Promise<boolean> {
  const { createServerClient } = await import('@/lib/supabase')
  const supabase = createServerClient()
  const { data, error } = await supabase.rpc('credit_payment_once', {
    p_payment_id: paymentId,
    p_user_id: userId,
    p_seconds: seconds,
  })
  if (error) {
    console.error('[billing] credit_payment_once failed:', error.message)
    return false
  }
  return data === true
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

/** Format a credit balance as tokens (1 token = 3600 credit-seconds = $2). */
export function formatTokens(seconds: number): string {
  if (seconds <= 0) return '0 tkn'
  const t = seconds / 3600
  if (t >= 100) return `${Math.floor(t)} tkn`
  if (t >= 10)  return `${t.toFixed(1)} tkn`
  return `${t.toFixed(2)} tkn`
}
