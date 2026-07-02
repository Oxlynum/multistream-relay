// Server-only billing clock shared by the two heartbeat paths that meter a live stream:
//   • the all-in-one pod heartbeat (label='pod') in app/api/agent/status
//   • the VPS hub Clock A per-tenant loop (one hub heartbeat bills many tenants)
// Keeping the deduction in one place guarantees both paths charge identically and are
// plan-aware (allotment-first, passthrough cheaper for subscribers).

import {
  buildBillingContext,
  computeBurnRate,
  billStreamIntervalTx,
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
  /** gpu_instances.id — the billing cursor lives here (last_billed_at) and anchors the ledger. */
  instanceId: string
  /** stream_sessions.id (nullable) — the running credits_deducted total accrues here. */
  sessionId: string | null
  profile: BillProfile | null
  platforms: BillingPlatformRow[]
  streaming: boolean
  /** CORR-04: tokens carried over from prior beats whose deduction RPC failed. */
  priorDebt?: number
  /** Billing cursor (last_billed_at). null on the first bill of a session. */
  lastBilledAtMs: number | null
  /** Liveness stamp (last_seen_at) — the fallback elapsed anchor on the first bill only. */
  lastSeenAtMs: number
  nowMs: number
  billingActive: boolean
  devBypass?: boolean
}): Promise<BillResult> {
  const {
    userId, instanceId, sessionId, profile, platforms, streaming, priorDebt = 0,
    lastBilledAtMs, lastSeenAtMs, nowMs, billingActive, devBypass = false,
  } = opts

  const plan: Plan = profile?.plan === 'subscription' ? 'subscription' : 'payg'
  const outputSettings = (profile?.output_settings as OutputSettingsMap) ?? {}
  const has2kAddon = profile?.has_2k_addon ?? false

  const ctx = buildBillingContext(platforms, outputSettings, has2kAddon, streaming)
  const burnRate = computeBurnRate(ctx, streaming, plan)

  // Bill from the last BILLED moment (the cursor), NOT the liveness stamp — decoupled so a
  // liveness-only update can't shift the billing anchor (M5). First bill (cursor null) anchors on
  // the last liveness beat. Capped so a long gap (missed beats / restart) can't surprise-overcharge.
  const anchorMs = lastBilledAtMs ?? lastSeenAtMs
  const elapsed = Math.min(Math.max(0, (nowMs - anchorMs) / 1000), MAX_BILL_INTERVAL_S)
  // 6dp (not 3) so a 10s passthrough beat (0.05–0.1 tok/hr → ~0.0001–0.0003 tok) is a
  // non-zero charge that the numeric(12,6) balance accumulates — otherwise passthrough
  // rounds to free at the heartbeat cadence (revenue leak; violates "never free").
  const deduct = parseFloat((burnRate * elapsed / 3600).toFixed(6))
  // CORR-04: charge this beat's cost PLUS any debt carried from prior beats whose deduction RPC
  // failed. Settling the whole `owed` at once on recovery keeps billing accurate. (deduct stays
  // this-beat-only for telemetry; owed is what we actually try to collect.)
  const owed = parseFloat((deduct + Math.max(0, priorDebt)).toFixed(6))

  let spendableAfter = spendableTokens(profile)
  let charged = false
  let unbilledDebt = 0

  if (billingActive && owed > 0 && !devBypass) {
    // Idempotent + atomic: CAS the cursor, append the ledger row, deduct allotment-first — all in
    // one txn. A duplicate/overlapping beat for the same interval charges nothing (M5).
    const res = await billStreamIntervalTx({
      instanceId, userId, sessionId,
      prevBilledAt: lastBilledAtMs !== null ? new Date(lastBilledAtMs).toISOString() : null,
      periodStart: new Date(anchorMs).toISOString(),
      periodEnd: new Date(nowMs).toISOString(),
      seconds: elapsed, tokens: owed, burnRate, billedModel: plan,
    })
    if (res === null) {
      // CORR-04 fail-closed: the RPC call errored. Carry the FULL owed forward (the caller
      // persists it on the session row so it accrues across beats) and drop the local spendable
      // estimate by it, so kill-on-empty trips once accrued debt reaches the balance — instead of
      // silently granting free streaming for the whole duration of the fault.
      // NB AT-LEAST-ONCE: if the txn COMMITTED but its response was lost (timeout after commit),
      // the balance is already decremented yet we carry `owed` forward → the next successful beat
      // over-charges by ~one beat. Bounded, self-limiting, and in the SAFE over-charge direction.
      unbilledDebt = owed
      spendableAfter = Math.max(0, spendableAfter - owed)
    } else {
      // res.charged=true  → we won the CAS and deducted `owed`.
      // res.charged=false → a concurrent/retried beat already billed this exact interval.
      // BOTH mean the interval is fully accounted for, so settle any carried debt either way.
      spendableAfter = res.spendable
      charged = res.charged
      unbilledDebt = 0
    }
  }

  return { burnRate, deduct, spendableAfter, charged, unbilledDebt, plan }
}
