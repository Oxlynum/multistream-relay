import Stripe from 'stripe'

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-05-27.dahlia',
})

export const PLANS = {
  monthly:  { priceId: process.env.STRIPE_PRICE_MONTHLY!,  label: 'Pro Monthly', amount: 900,  interval: 'month' },
  annual:   { priceId: process.env.STRIPE_PRICE_ANNUAL!,   label: 'Pro Annual',  amount: 5900, interval: 'year'  },
  lifetime: { priceId: process.env.STRIPE_PRICE_LIFETIME!, label: 'Lifetime',    amount: 9900, interval: null    },
} as const
