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
