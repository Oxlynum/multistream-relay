// Server-only billing clock shared by the two heartbeat paths that meter a live stream:
//   • the all-in-one pod heartbeat (label='pod') in app/api/agent/status
//   • the VPS hub Clock A per-tenant loop (one hub heartbeat bills many tenants)
// Keeping the deduction in one place guarantees both paths charge identically and are
// plan-aware (allotment-first, passthrough cheaper for subscribers).

import {
  buildBillingContext,
  computeBurnRate,
  deductTokens,
  spendableTokens,
  type BillingPlatformRow,
  type OutputSettingsMap,
  type Plan,
} from '@/lib/billing'

// Never bill more than this many seconds per heartbeat, even if the previous heartbeat
// was long ago (missed beats / restart) — avoids surprise overcharges.
export const MAX_BILL_INTERVAL_S = 60

// Budget tiers 0–1 keep 1440p; tier ≥2 has downscaled to ≤1080p, so a 2K user throttled
// there shouldn't be charged the 2K adder for that interval.
const THROTTLE_BELOW_1440_TIER = 2

export interface BillProfile {
  plan?: string | null
  allotment_tokens?: number | string | null
  streaming_credits?: number | string | null
  has_2k_addon?: boolean | null
  output_settings?: OutputSettingsMap | null
}

export interface BillResult {
  /** tokens/hr at the current config (telemetry even when billing is off). */
  burnRate: number
  /** tokens actually charged this interval (0 if billing off / dev bypass / not streaming). */
  deduct: number
  /** total spendable tokens (allotment + purchased) AFTER this interval's deduction. */
  spendableAfter: number
  /** true iff a real deduction hit the DB this interval. */
  charged: boolean
  /** the resolved plan used for the rate. */
  plan: Plan
}

/**
 * Meter one heartbeat interval for one tenant. Computes the plan-aware burn rate, the
 * elapsed-time deduction (capped), and — when billing is active — atomically deducts
 * (allotment first, then purchased) via the deduct_tokens RPC. Returns the post-interval
 * spendable balance so the caller can apply the kill-on-empty rule.
 */
export async function billStreamInterval(opts: {
  userId: string
  profile: BillProfile | null
  platforms: BillingPlatformRow[]
  streaming: boolean
  throttleTier?: number
  lastSeenAtMs: number
  nowMs: number
  billingActive: boolean
  devBypass?: boolean
}): Promise<BillResult> {
  const {
    userId, profile, platforms, streaming,
    throttleTier = 0, lastSeenAtMs, nowMs, billingActive, devBypass = false,
  } = opts

  const plan: Plan = profile?.plan === 'subscription' ? 'subscription' : 'payg'
  const outputSettings = (profile?.output_settings as OutputSettingsMap) ?? {}
  const has2kAddon = profile?.has_2k_addon ?? false
  const throttledBelow1440 = throttleTier >= THROTTLE_BELOW_1440_TIER

  const ctx = buildBillingContext(platforms, outputSettings, has2kAddon, streaming, throttledBelow1440)
  const burnRate = computeBurnRate(ctx, streaming, plan)

  const elapsed = Math.min(Math.max(0, (nowMs - lastSeenAtMs) / 1000), MAX_BILL_INTERVAL_S)
  // 6dp (not 3) so a 10s passthrough beat (0.05–0.1 tok/hr → ~0.0001–0.0003 tok) is a
  // non-zero charge that the numeric(12,6) balance accumulates — otherwise passthrough
  // rounds to free at the heartbeat cadence (revenue leak; violates "never free").
  const deduct = parseFloat((burnRate * elapsed / 3600).toFixed(6))

  let spendableAfter = spendableTokens(profile)
  let charged = false

  if (billingActive && deduct > 0 && !devBypass) {
    const after = await deductTokens(userId, deduct)
    if (after !== null) {
      spendableAfter = after
      charged = true
    } else {
      // RPC failed — fall back to a local estimate so the kill logic still behaves.
      spendableAfter = Math.max(0, spendableAfter - deduct)
    }
  }

  return { burnRate, deduct, spendableAfter, charged, plan }
}
