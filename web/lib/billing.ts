// Pricing model: streaming credits stored as tokens. 1 token = 1 hour of base GPU
// transcode = $2.00 (PAYG / buy-more base rate).
//
// Two-tier (Phase 3):
//   • PAYG          — meter everything against the purchased balance (profiles.streaming_credits).
//   • SUBSCRIPTION  — a monthly token allotment (rolls over, capped) spent before the purchased
//                     balance, plus cheaper passthrough.
//
// Burn rate (tokens/hr), single source of truth — billingLineItems():
//   PASSTHROUGH GROUP (YouTube HLS + eligible-Twitch eRTMP + future), flat, once:
//     +0.05 token/hr  subscriber    (cheaper — but never free: a 24/7 idle passthrough still
//     +0.10 token/hr  PAYG           burns our VPS bandwidth, so it must cost something)
//   TRANSCODE (NVENC), when present:
//     +1.0  token/hr  base (first transcode output, any orientation)
//     +0.2  token/hr  each additional landscape transcode beyond the first
//     +0.2  token/hr  each portrait platform going to a DIFFERENT platform than landscape
//     +0.1  token/hr  each portrait platform ALSO getting landscape ("dual format")
//     +0.5  token/hr  any output at 1440p (requires has_2k_addon)
//     +0.5  token/hr  Pro streaming (requiredNvencSessions > 3 → professional GPU required)

import { requiredNvencSessions, type UserOutputConfig } from '@/lib/nvenc-utils'

/** Billing plan. Mirrors profiles.plan. */
export type Plan = 'payg' | 'subscription'

/** Dollars per token (PAYG / buy-more base rate). */
export const TOKEN_PRICE_USD = 2.0

/** Flat passthrough-group rate (tokens/hr), by plan. Not per-platform. */
export const PASSTHROUGH_TOKENS_PER_HR: Record<Plan, number> = {
  subscription: 0.05,
  payg: 0.1,
}

/** Base transcode rate (tokens/hr) — covers the first transcode output. */
export const TRANSCODE_BASE_TOKENS_PER_HR = 1.0

/** Monthly subscription allotment + rollover cap (tokens). Editable via env. */
export const SUB_ALLOTMENT_TOKENS = Number(process.env.SLIMCAST_SUB_ALLOTMENT_TOKENS ?? 15)
export const SUB_ALLOTMENT_CAP = Number(process.env.SLIMCAST_SUB_ALLOTMENT_CAP ?? 30)

export interface OutputStatus {
  name: string
  state: string
  mode?: string
  platforms?: string[]
  restarts?: number
  last_exit?: number | null
}

export interface OutputSettings {
  resolution?: '720p' | '1080p' | '1440p'
  bitrate_kbps?: number
}

/** Platform output settings keyed by platform name. */
export type OutputSettingsMap = Record<string, OutputSettings>

/** Minimal platform row for billing classification (mirror of classifyMode inputs). */
export interface BillingPlatformRow {
  platform: string
  orientation: string
  enabled: boolean
  twitch_hevc_eligible?: boolean | null
  twitch_use_passthrough?: boolean | null
}

export interface BillingContext {
  /** Platforms in a landscape TRANSCODE group (state=running). */
  landscapePlatforms: string[]
  /** Platforms in a portrait TRANSCODE group (state=running). */
  portraitPlatforms: string[]
  /** Platforms on a GPU-free passthrough path: YouTube HLS + eligible-Twitch eRTMP. */
  passthroughPlatforms: string[]
  /** True if any running platform is configured for 1440p AND has_2k_addon is active. */
  has1440p: boolean
  /** True when the user's output mix requires >3 NVENC sessions (professional GPU). */
  needsProfessionalGpu: boolean
}

/** Per-line-item breakdown for the pricing UI. */
export interface PricingLineItem {
  platform: string
  label: string
  detail: string
  tokens_per_hr: number
}

export interface PricingBreakdown {
  line_items: PricingLineItem[]
  total_tokens_per_hr: number
  total_dollars_per_hr: number
}

// Passthrough = GPU-free. Mirrors agent-config.classifyMode WITHOUT importing it (keeps
// billing dependency-free + avoids a value import cycle). Keep the two in sync.
function isPassthroughPlatform(p: BillingPlatformRow): boolean {
  const landscape = p.orientation !== 'portrait'
  if (p.platform === 'youtube' && landscape) return true
  if (p.platform === 'twitch' && landscape && p.twitch_hevc_eligible && (p.twitch_use_passthrough ?? true)) return true
  return false
}

/**
 * Build a BillingContext from the active platform configuration.
 * Used by the heartbeat billing routes (pod + hub) and the pricing API.
 */
export function buildBillingContext(
  platforms: BillingPlatformRow[],
  outputSettings: OutputSettingsMap,
  has2kAddon: boolean,
  streaming: boolean,
  // NOTE (ARCH-01): dropped the resolutionThrottledBelow1440 param — the hub budget-throttle
  // that would have set it is deferred (CLAUDE.md §9a), so it was always false. When the
  // throttle returns, re-add it here to suppress the 2K adder while throttled below 1440p.
): BillingContext {
  if (!streaming) {
    return { landscapePlatforms: [], portraitPlatforms: [], passthroughPlatforms: [], has1440p: false, needsProfessionalGpu: false }
  }

  const enabled = platforms.filter(p => p.enabled)

  const landscapePlatforms: string[] = []
  const portraitPlatforms: string[] = []
  const passthroughPlatforms: string[] = []

  for (const p of enabled) {
    if (isPassthroughPlatform(p)) {
      passthroughPlatforms.push(p.platform)
    } else if (p.orientation === 'portrait') {
      portraitPlatforms.push(p.platform)
    } else {
      landscapePlatforms.push(p.platform)
    }
  }

  const allRunning = [...landscapePlatforms, ...portraitPlatforms, ...passthroughPlatforms]
  const has1440p =
    has2kAddon &&
    allRunning.some(p => outputSettings[p]?.resolution === '1440p')

  const userOutputs: UserOutputConfig[] = enabled.map(p => ({
    orientation: p.orientation,
    resolution: outputSettings[p.platform]?.resolution ?? '1080p',
    bitrate_kbps: outputSettings[p.platform]?.bitrate_kbps ?? (p.orientation === 'portrait' ? 4000 : 6000),
    mode: isPassthroughPlatform(p) ? 'passthrough' : 'transcode',
    enabled: true,
  }))
  const needsProfessionalGpu = requiredNvencSessions(userOutputs) > 3

  return { landscapePlatforms, portraitPlatforms, passthroughPlatforms, has1440p, needsProfessionalGpu }
}

/**
 * THE single source of truth for billing math. Both computeBurnRate (deduction) and
 * buildPricingBreakdown (UI) derive from this exact item list, so they can never drift.
 */
export function billingLineItems(ctx: BillingContext, plan: Plan): PricingLineItem[] {
  const items: PricingLineItem[] = []

  const landscape = ctx.landscapePlatforms
  const portrait = ctx.portraitPlatforms
  const hasTranscode = landscape.length + portrait.length > 0
  const hasPassthrough = ctx.passthroughPlatforms.length > 0

  if (hasTranscode) {
    const landscapeSet = new Set(landscape)

    // Base covers the first transcode output (landscape preferred, else portrait).
    if (landscape.length > 0) {
      items.push({ platform: landscape[0], label: `${landscape[0]} — landscape (base)`, detail: 'Base transcode', tokens_per_hr: TRANSCODE_BASE_TOKENS_PER_HR })
    } else {
      items.push({ platform: portrait[0], label: `${portrait[0]} — portrait (base)`, detail: 'Base transcode', tokens_per_hr: TRANSCODE_BASE_TOKENS_PER_HR })
    }

    // Additional landscape transcodes beyond the first.
    for (let i = 1; i < landscape.length; i++) {
      items.push({ platform: landscape[i], label: `${landscape[i]} — landscape`, detail: 'Extra landscape output', tokens_per_hr: 0.2 })
    }

    // Portraits: each is additional unless it IS the base (only when there's no landscape).
    const portraitStart = landscape.length > 0 ? 0 : 1
    for (let i = portraitStart; i < portrait.length; i++) {
      const p = portrait[i]
      // Dual-format (+0.1): the SAME platform streamed in BOTH orientations. Reserved tier
      // — today platform_connections is UNIQUE(user_id, platform) with one orientation, so
      // a platform can't appear in both buckets and this stays 0.2. Kept so the rate is
      // already correct if/when dual-orientation output ships (no billing change needed).
      const isDual = landscapeSet.has(p)
      items.push({
        platform: p,
        label: `${p} — ${isDual ? 'dual format' : 'portrait'}`,
        detail: isDual ? 'Same platform, dual format' : 'Portrait output',
        tokens_per_hr: isDual ? 0.1 : 0.2,
      })
    }

    if (ctx.has1440p) {
      items.push({ platform: '_2k', label: '2K (1440p) add-on', detail: 'Any output at 1440p', tokens_per_hr: 0.5 })
    }
    if (ctx.needsProfessionalGpu) {
      items.push({ platform: '_pro', label: 'Pro streaming', detail: '>3 NVENC sessions', tokens_per_hr: 0.5 })
    }
  }

  // Passthrough group: ONE flat charge regardless of how many passthrough platforms.
  if (hasPassthrough) {
    const rate = PASSTHROUGH_TOKENS_PER_HR[plan]
    items.push({
      platform: '_passthrough',
      label: `${ctx.passthroughPlatforms.join(' + ')} — passthrough`,
      detail: plan === 'subscription' ? 'Passthrough (subscriber rate)' : 'Passthrough',
      tokens_per_hr: rate,
    })
  }

  return items
}

/**
 * Compute burn rate in tokens/hr. Returns 0 when not streaming. Plan-aware (passthrough
 * is cheaper for subscribers). Sums billingLineItems so it can never diverge from the UI.
 */
export function computeBurnRate(ctx: BillingContext, streaming: boolean, plan: Plan = 'payg'): number {
  if (!streaming) return 0
  const total = billingLineItems(ctx, plan).reduce((s, i) => s + i.tokens_per_hr, 0)
  return Math.round(total * 1000) / 1000
}

/** Build a human-readable pricing breakdown from a billing context. */
export function buildPricingBreakdown(ctx: BillingContext, plan: Plan = 'payg'): PricingBreakdown {
  const items = billingLineItems(ctx, plan)
  const total = items.reduce((s, i) => s + i.tokens_per_hr, 0)
  return {
    line_items: items,
    total_tokens_per_hr: Math.round(total * 1000) / 1000,
    total_dollars_per_hr: Math.round(total * TOKEN_PRICE_USD * 1000) / 1000,
  }
}

/** Seconds of real streaming time left at the current burn rate (tokens/hr). */
export function secondsRemaining(credits: number, burnRate: number): number {
  if (burnRate <= 0) return credits * 3600
  return Math.floor((credits / burnRate) * 3600)
}

/** Total spendable tokens = rolling allotment (subscribers) + purchased balance. */
export function spendableTokens(profile: { allotment_tokens?: number | string | null; streaming_credits?: number | string | null } | null): number {
  const allot = parseFloat(String(profile?.allotment_tokens ?? '0')) || 0
  const purchased = parseFloat(String(profile?.streaming_credits ?? '0')) || 0
  return Math.round((allot + purchased) * 1000) / 1000
}

/**
 * Credit a user for a Stripe payment exactly once. Idempotent on paymentId via a
 * single-transaction Postgres function (credit_payment_once). Tops up the PURCHASED
 * balance (streaming_credits). Returns true if it credited now, false if already credited.
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

/**
 * Atomically deduct tokens (allotment first, then purchased) under a row lock.
 * Returns the new total spendable, or null on error / missing user.
 */
export async function deductTokens(userId: string, amount: number): Promise<number | null> {
  if (!(amount > 0)) return null
  const { createServerClient } = await import('@/lib/supabase')
  const supabase = createServerClient()
  const { data, error } = await supabase.rpc('deduct_tokens', {
    p_user_id: userId,
    p_amount: amount,
  })
  if (error) {
    console.error('[billing] deduct_tokens failed:', error.message)
    return null
  }
  return data === null || data === undefined ? null : Number(data)
}

/**
 * Grant the monthly subscription allotment exactly once per Stripe invoice (rollover,
 * capped). Returns true if granted now, false if already granted (idempotent).
 */
export async function grantSubscriptionAllotment(
  invoiceId: string,
  userId: string,
  tokens: number,
  cap: number,
): Promise<boolean> {
  const { createServerClient } = await import('@/lib/supabase')
  const supabase = createServerClient()
  const { data, error } = await supabase.rpc('grant_subscription_allotment', {
    p_invoice_id: invoiceId,
    p_user_id: userId,
    p_tokens: tokens,
    p_cap: cap,
  })
  if (error) {
    console.error('[billing] grant_subscription_allotment failed:', error.message)
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
