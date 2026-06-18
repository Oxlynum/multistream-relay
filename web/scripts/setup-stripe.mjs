// Run once: node scripts/setup-stripe.mjs
// Creates the SlimCast hourly price in Stripe and prints the price ID.
import Stripe from 'stripe'

const key = process.env.STRIPE_SECRET_KEY
if (!key) {
  console.error('Set STRIPE_SECRET_KEY env var before running.')
  process.exit(1)
}

const stripe = new Stripe(key, { apiVersion: '2026-05-27.dahlia' })

const price = await stripe.prices.create({
  unit_amount: 200,
  currency: 'usd',
  product_data: {
    name: 'SlimCast Streaming Time',
    statement_descriptor: 'SLIMCAST',
  },
})

console.log('Price ID:', price.id)
console.log('')
console.log('Run this to add it to Vercel:')
console.log(`printf "${price.id}" | npx vercel env add STRIPE_PRICE_HOURLY production`)
