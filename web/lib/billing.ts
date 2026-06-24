// Pricing model: pay-per-use streaming credits stored as tokens.
//   1 token = 1 hour of streaming at base rate = $2.00
//
// What's included in the base 1 token/hr:
//   - YouTube HEVC passthrough (no encode — always free)
//   - the first transcoded platform
// Each ADDITIONAL transcoded platform adds 0.2 token/hr.

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
 * Burn rate in tokens/hr.
 *   not streaming                                     → 0
 *   streaming, passthrough-only or 1 transcode        → 1.0 (base)
 *   each transcode beyond the first                   → +0.2
 */
export function burnRatePerHr(transcodes: number, streaming: boolean): number {
  if (!streaming) return 0
  return 1 + 0.2 * Math.max(0, transcodes - 1)
}

/** Seconds of real streaming time left at the current burn rate (tokens/hr). */
export function secondsRemaining(credits: number, burnRate: number): number {
  if (burnRate <= 0) return credits * 3600
  return Math.floor((credits / burnRate) * 3600)
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
  tokens: number,
): Promise<boolean> {
  const { createServerClient } = await import('@/lib/supabase')
  const supabase = createServerClient()
  const { data, error } = await supabase.rpc('credit_payment_once', {
    p_payment_id: paymentId,
    p_user_id: userId,
    p_tokens: tokens,
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

/** Format a token balance to 3 decimal places for display. */
export function formatTokens(tokens: number): string {
  if (tokens <= 0) return '0 tkn'
  if (tokens >= 100) return `${Math.floor(tokens)} tkn`
  if (tokens >= 10)  return `${tokens.toFixed(1)} tkn`
  return `${tokens.toFixed(3)} tkn`
}
