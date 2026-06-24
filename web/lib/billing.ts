// Pricing model: pay-per-use streaming credits stored as tokens.
//   1 token = 1 hour of streaming at base rate = $2.00
//
// Base 1 token/hr covers:
//   - The first transcoded platform (any orientation) OR a passthrough
//
// Adders (while streaming):
//   +0.2 token/hr — each additional landscape platform beyond the first
//   +0.2 token/hr — each portrait platform going to a DIFFERENT platform than landscape
//   +0.1 token/hr — each portrait platform ALSO getting landscape ("dual format")
//   +0.5 token/hr — any output at 1440p (requires has_2k_addon)
//   +0.5 token/hr — Pro streaming (requiredNvencSessions > 3 → professional GPU required)

import { requiredNvencSessions, type UserOutputConfig } from '@/lib/nvenc-utils'

export interface OutputStatus {
  name: string
  state: string
  mode?: string
  platforms?: string[]
}

export interface OutputSettings {
  resolution?: '720p' | '1080p' | '1440p'
  bitrate_kbps?: number
}

/** Platform output settings keyed by platform name. */
export type OutputSettingsMap = Record<string, OutputSettings>

export interface BillingContext {
  /** Platforms in a landscape transcode group (state=running). YouTube is excluded — it's passthrough. */
  landscapePlatforms: string[]
  /** Platforms in a portrait transcode group (state=running). */
  portraitPlatforms: string[]
  /** Platforms receiving HEVC passthrough (currently always YouTube landscape). */
  passthroughPlatforms: string[]
  /** True if any running platform is configured for 1440p AND has_2k_addon is active. */
  has1440p: boolean
  /** True when the user's output mix requires >3 NVENC sessions (professional GPU). */
  needsProfessionalGpu: boolean
}

/**
 * Compute burn rate in tokens/hr from a billing context.
 * Returns 0 when not streaming.
 */
export function computeBurnRate(ctx: BillingContext, streaming: boolean): number {
  if (!streaming) return 0

  const total = ctx.landscapePlatforms.length + ctx.portraitPlatforms.length + ctx.passthroughPlatforms.length
  if (total === 0) return 0

  let rate = 1.0 // base: first output covered

  const landscapeSet = new Set(ctx.landscapePlatforms)

  // Extra landscape transcodes beyond the first
  rate += Math.max(0, ctx.landscapePlatforms.length - 1) * 0.2

  // Portrait platforms: dual-format (+0.1) if same platform as landscape, else (+0.2)
  for (const p of ctx.portraitPlatforms) {
    rate += landscapeSet.has(p) ? 0.1 : 0.2
  }

  // 1440p add-on
  if (ctx.has1440p) rate += 0.5

  // Pro streaming surcharge (4+ simultaneous NVENC sessions)
  if (ctx.needsProfessionalGpu) rate += 0.5

  return Math.round(rate * 1000) / 1000
}

/**
 * Build a BillingContext from the active platform configuration.
 * Used both in the heartbeat billing route and the pricing API.
 */
export function buildBillingContext(
  platforms: Array<{ platform: string; orientation: string; enabled: boolean }>,
  outputSettings: OutputSettingsMap,
  has2kAddon: boolean,
  streaming: boolean,
): BillingContext {
  if (!streaming) {
    return { landscapePlatforms: [], portraitPlatforms: [], passthroughPlatforms: [], has1440p: false, needsProfessionalGpu: false }
  }

  const enabled = platforms.filter(p => p.enabled)

  const landscapePlatforms: string[] = []
  const portraitPlatforms: string[] = []
  const passthroughPlatforms: string[] = []

  for (const p of enabled) {
    const isPortrait = p.orientation === 'portrait'
    // YouTube landscape → HEVC passthrough (not a transcode, doesn't count as landscape transcode)
    if (p.platform === 'youtube' && !isPortrait) {
      passthroughPlatforms.push(p.platform)
    } else if (isPortrait) {
      portraitPlatforms.push(p.platform)
    } else {
      landscapePlatforms.push(p.platform)
    }
  }

  const allRunning = [...landscapePlatforms, ...portraitPlatforms, ...passthroughPlatforms]
  const has1440p = has2kAddon && allRunning.some(p => outputSettings[p]?.resolution === '1440p')

  const userOutputs: UserOutputConfig[] = enabled.map(p => ({
    orientation: p.orientation,
    resolution: outputSettings[p.platform]?.resolution ?? '1080p',
    bitrate_kbps: outputSettings[p.platform]?.bitrate_kbps ?? (p.orientation === 'portrait' ? 4000 : 6000),
    mode: (p.platform === 'youtube' && p.orientation !== 'portrait') ? 'passthrough' : 'transcode',
    enabled: true,
  }))
  const needsProfessionalGpu = requiredNvencSessions(userOutputs) > 3

  return { landscapePlatforms, portraitPlatforms, passthroughPlatforms, has1440p, needsProfessionalGpu }
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

/** Build a human-readable pricing breakdown from a billing context. */
export function buildPricingBreakdown(ctx: BillingContext): PricingBreakdown {
  const items: PricingLineItem[] = []

  const all = [
    ...ctx.landscapePlatforms,
    ...ctx.passthroughPlatforms,
    ...ctx.portraitPlatforms,
  ]

  if (all.length === 0) {
    return { line_items: [], total_tokens_per_hr: 0, total_dollars_per_hr: 0 }
  }

  const landscapeSet = new Set(ctx.landscapePlatforms)

  // Base covers first platform
  let baseLabel = ''
  if (ctx.landscapePlatforms.length > 0) {
    baseLabel = `${ctx.landscapePlatforms[0]} — landscape (base)`
  } else if (ctx.passthroughPlatforms.length > 0) {
    baseLabel = `${ctx.passthroughPlatforms[0]} — passthrough (base)`
  } else if (ctx.portraitPlatforms.length > 0) {
    baseLabel = `${ctx.portraitPlatforms[0]} — portrait (base)`
  }

  items.push({ platform: all[0], label: baseLabel, detail: 'Base rate', tokens_per_hr: 1.0 })

  // Passthrough platforms (free after base)
  for (const p of ctx.passthroughPlatforms) {
    if (p === all[0]) continue
    items.push({ platform: p, label: `${p} — passthrough`, detail: 'Included in base', tokens_per_hr: 0 })
  }

  // Extra landscape platforms
  for (let i = 1; i < ctx.landscapePlatforms.length; i++) {
    const p = ctx.landscapePlatforms[i]
    items.push({ platform: p, label: `${p} — landscape`, detail: 'Extra landscape output', tokens_per_hr: 0.2 })
  }

  // Portrait platforms
  for (const p of ctx.portraitPlatforms) {
    if (p === all[0]) continue // already counted in base
    const isDual = landscapeSet.has(p)
    items.push({
      platform: p,
      label: `${p} — ${isDual ? 'dual format' : 'portrait'}`,
      detail: isDual ? 'Same platform, dual format' : 'Portrait output',
      tokens_per_hr: isDual ? 0.1 : 0.2,
    })
  }

  // 1440p add-on
  if (ctx.has1440p) {
    items.push({ platform: '_2k', label: '2K (1440p) add-on', detail: 'Any output at 1440p', tokens_per_hr: 0.5 })
  }

  // Pro streaming surcharge
  if (ctx.needsProfessionalGpu) {
    items.push({ platform: '_pro', label: 'Pro streaming', detail: 'Your output mix', tokens_per_hr: 0.5 })
  }

  const total = items.reduce((s, i) => s + i.tokens_per_hr, 0)

  return {
    line_items: items,
    total_tokens_per_hr: Math.round(total * 1000) / 1000,
    total_dollars_per_hr: Math.round(total * 2 * 1000) / 1000,
  }
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

