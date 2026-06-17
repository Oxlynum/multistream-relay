import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'
import { createServerClient } from '@/lib/supabase'
import Stripe from 'stripe'

async function upgradeToPro(customerId: string) {
  const supabase = createServerClient()
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()
  if (!profile) return

  await supabase.from('profiles').update({ tier: 'pro' }).eq('id', profile.id)
  await supabase.from('license_keys').update({ tier: 'pro' }).eq('user_id', profile.id)
}

async function downgradeToFree(customerId: string) {
  const supabase = createServerClient()
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .single()
  if (!profile) return

  await supabase.from('profiles').update({ tier: 'free' }).eq('id', profile.id)
  await supabase.from('license_keys').update({ tier: 'free' }).eq('user_id', profile.id)
}

export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig = req.headers.get('stripe-signature')!

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const customerId = (event.data.object as { customer?: string }).customer as string

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      // Handle lifetime purchase (one-time payment)
      if (session.mode === 'payment') {
        await upgradeToPro(session.customer as string)
      }
      break
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription
      if (sub.status === 'active' || sub.status === 'trialing') {
        await upgradeToPro(customerId)
      } else {
        await downgradeToFree(customerId)
      }
      break
    }
    case 'customer.subscription.deleted':
      await downgradeToFree(customerId)
      break
  }

  return NextResponse.json({ received: true })
}
