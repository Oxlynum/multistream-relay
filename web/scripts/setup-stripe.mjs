// Run once: node scripts/setup-stripe.mjs
// Creates the SlimCast Stripe prices and prints the IDs + the Vercel env commands.
//   • Hourly / token price  — one-time, $2.00/unit (1 token = 1 hour). Used for the
//     pay-as-you-go credit purchase + auto-refill + buy-more-tokens.
//   • Subscription price    — recurring $20.00/month. Grants the monthly token allotment.
// Amounts are read from env so you can change them without editing this script:
//   SLIMCAST_TOKEN_PRICE_CENTS (default 200), SLIMCAST_SUB_PRICE_CENTS (default 2000).
import Stripe from 'stripe'

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('Set STRIPE_SECRET_KEY env var before running.')
  process.exit(1)
}

const stripe = new Stripe(key, { apiVersion: '2026-05-27.dahlia' })

const tokenCents = Number(process.env.SLIMCAST_TOKEN_PRICE_CENTS ?? 200)
const subCents = Number(process.env.SLIMCAST_SUB_PRICE_CENTS ?? 2000)

// One-time token / hourly price (variable quantity at checkout).
const tokenPrice = await stripe.prices.create({
  unit_amount: tokenCents,
  currency: 'usd',
  product_data: {
    name: 'SlimCast Streaming Time',
    statement_descriptor: 'SLIMCAST',
  },
})

// Recurring monthly subscription price.
const subPrice = await stripe.prices.create({
  unit_amount: subCents,
  currency: 'usd',
  recurring: { interval: 'month' },
  product_data: {
    name: 'SlimCast Subscription',
    statement_descriptor: 'SLIMCAST SUB',
  },
})

console.log('Token/hourly price ID:', tokenPrice.id, `($${(tokenCents / 100).toFixed(2)}/token)`)
console.log('Subscription price ID:', subPrice.id, `($${(subCents / 100).toFixed(2)}/month)`)
console.log('')
console.log('Add them to Vercel:')
console.log(`printf "${tokenPrice.id}" | npx vercel env add STRIPE_PRICE_HOURLY production`)
console.log(`printf "${subPrice.id}" | npx vercel env add STRIPE_PRICE_SUBSCRIPTION production`)
