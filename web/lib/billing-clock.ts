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

// NOTE (ARCH-01, removed 2026-06-30): the budget-throttle inputs (throttleTier /
// throttledBelow1440) were deleted from this clock. The hub-side BudgetController that would
// have written them was removed 2026-06-29 (CLAUDE.md §9a), so nothing ever set them —
// throttledBelow1440 was permanently false and the 2K-suppression branch was dead. When the
// hub throttle is reintroduced (a future VPS/billing plan, §9a is the doc of record), re-add
// the tier input HERE and re-thread it into buildBillingContext.

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
  lastSeenAtMs: number
  nowMs: number
  billingActive: boolean
  devBypass?: boolean
}): Promise<BillResult> {
  const {
    userId, profile, platforms, streaming,
    lastSeenAtMs, nowMs, billingActive, devBypass = false,
  } = opts

  const plan: Plan = profile?.plan === 'subscription' ? 'subscription' : 'payg'
  const outputSettings = (profile?.output_settings as OutputSettingsMap) ?? {}
  const has2kAddon = profile?.has_2k_addon ?? false

  const ctx = buildBillingContext(platforms, outputSettings, has2kAddon, streaming)
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
