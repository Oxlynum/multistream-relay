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
  /** CORR-04: tokens owed but NOT yet persisted — carried forward when deduct_tokens failed,
   *  0 once settled. The caller persists this on the session row so it accrues across beats. */
  unbilledDebt: number
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
  /** CORR-04: tokens carried over from prior beats whose deduct_tokens RPC failed. */
  priorDebt?: number
  lastSeenAtMs: number
  nowMs: number
  billingActive: boolean
  devBypass?: boolean
}): Promise<BillResult> {
  const {
    userId, profile, platforms, streaming, priorDebt = 0,
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
  // CORR-04: charge this beat's cost PLUS any debt carried from prior beats whose deduct_tokens
  // RPC failed. Settling the whole `owed` at once on recovery keeps billing accurate. (deduct
  // stays this-beat-only for telemetry; owed is what we actually try to collect.)
  const owed = parseFloat((deduct + Math.max(0, priorDebt)).toFixed(6))

  let spendableAfter = spendableTokens(profile)
  let charged = false
  let unbilledDebt = 0

  if (billingActive && owed > 0 && !devBypass) {
    const after = await deductTokens(userId, owed)
    if (after !== null) {
      // Settled this beat's charge AND all carried debt.
      spendableAfter = after
      charged = true
    } else {
      // CORR-04 fail-closed: deduct_tokens failed. Carry the FULL owed forward (the caller
      // persists it on the session row so it accrues across beats) and drop the local spendable
      // estimate by it, so kill-on-empty trips once accrued debt reaches the balance — instead
      // of the OLD behaviour, which discarded the charge and reset to the full un-decremented
      // balance every beat → silent free streaming for the entire duration of the fault.
      // NB AT-LEAST-ONCE: if the RPC actually COMMITTED but its response was lost (timeout after
      // commit), the balance is already decremented yet we treat it as failed and carry `owed`
      // forward → the next successful beat over-charges by ~one beat's owed. Bounded (~one beat),
      // self-limiting, and in the SAFE over-charge direction — an accepted price of closing the
      // far larger silent-free-streaming leak; a future idempotent deduct (request-id dedup)
      // would eliminate it.
      unbilledDebt = owed
      spendableAfter = Math.max(0, spendableAfter - owed)
    }
  }

  return { burnRate, deduct, spendableAfter, charged, unbilledDebt, plan }
}
