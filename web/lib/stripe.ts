import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-05-27.dahlia',
})

// $2.00 per hour, billed per unit at checkout. One price, variable quantity.
export const HOURLY_RATE_CENTS = 200
export const HOURLY_PRICE_ID = process.env.STRIPE_PRICE_HOURLY!

export function hoursToSeconds(hours: number) {
  return hours * 3600
}
