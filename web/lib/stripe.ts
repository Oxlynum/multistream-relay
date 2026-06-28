import Stripe from 'stripe'

let _stripe: Stripe | null = null
export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-05-27.dahlia',
    })
  }
  return _stripe
}

// Keep backward-compat export for callers that use `stripe` directly.
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    return (getStripe() as unknown as Record<string | symbol, unknown>)[prop]
  },
})

// $2.00 per hour, billed per unit at checkout. One price, variable quantity.
export const HOURLY_RATE_CENTS = 200
export const HOURLY_PRICE_ID = process.env.STRIPE_PRICE_HOURLY!

export function hoursToSeconds(hours: number) {
  return hours * 3600
}

/** Convert hours purchased to tokens (1 token = 1 hour = $2.00). */
export function hoursToTokens(hours: number): number {
  return hours
}

// ── Subscription tier (Phase 3) ──────────────────────────────────────────────
// Recurring monthly subscription: a flat fee that grants a monthly token allotment
// (rolls over, capped) + cheaper passthrough. Price ID is created by setup-stripe.mjs.
export const SUBSCRIPTION_PRICE_ID = process.env.STRIPE_PRICE_SUBSCRIPTION ?? ''
export const SUBSCRIPTION_PRICE_CENTS = Number(process.env.SLIMCAST_SUB_PRICE_CENTS ?? 2000)

// Buy-more tokens: 1 token = 1 hour = $2.00, so the existing hourly price IS the token
// price. Allow a dedicated STRIPE_PRICE_TOKEN override; otherwise fall back to hourly.
export const TOKEN_PRICE_ID = process.env.STRIPE_PRICE_TOKEN || process.env.STRIPE_PRICE_HOURLY || ''
export const TOKEN_PRICE_CENTS = Number(process.env.SLIMCAST_TOKEN_PRICE_CENTS ?? 200)
