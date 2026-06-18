import { NextRequest, NextResponse } from 'next/server'
import { stripe, hoursToSeconds } from '@/lib/stripe'
import { createServerClient } from '@/lib/supabase'
import Stripe from 'stripe'

async function addCredits(userId: string, seconds: number) {
  const supabase = createServerClient()
  const { data: profile } = await supabase
    .from('profiles')
    .select('streaming_credits_seconds')
    .eq('id', userId)
    .single()
  if (!profile) return

  await supabase
    .from('profiles')
    .update({ streaming_credits_seconds: (profile.streaming_credits_seconds ?? 0) + seconds })
    .eq('id', userId)
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

  const supabase = createServerClient()

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      if (session.mode !== 'payment' || session.payment_status !== 'paid') break

      const userId = session.metadata?.user_id
      const creditsSeconds = parseInt(session.metadata?.credits_seconds ?? '0', 10)
      if (userId && creditsSeconds > 0) {
        await addCredits(userId, creditsSeconds)
      }

      // Persist stripe_customer_id.
      if (userId && session.customer) {
        await supabase
          .from('profiles')
          .update({ stripe_customer_id: session.customer as string })
          .eq('id', userId)
          .is('stripe_customer_id', null)
      }

      // Save payment method for auto-refill (set via setup_future_usage: off_session).
      if (userId && session.payment_intent) {
        const pi = await stripe.paymentIntents.retrieve(session.payment_intent as string)
        if (pi.payment_method) {
          await supabase
            .from('profiles')
            .update({ stripe_payment_method_id: pi.payment_method as string })
            .eq('id', userId)
        }
      }
      break
    }

    case 'payment_intent.succeeded': {
      // Handles auto-refill charges (off_session). Checkout session already
      // added credits above, so only process if tagged as auto_refill.
      const pi = event.data.object as Stripe.PaymentIntent
      if (pi.metadata?.auto_refill !== 'true') break

      const userId = pi.metadata?.user_id
      const creditsSeconds = parseInt(pi.metadata?.credits_seconds ?? '0', 10)
      // addCredits is safe to call again — auto-refill route already added them
      // optimistically, but if that failed this webhook is the backstop.
      if (userId && creditsSeconds > 0) {
        await addCredits(userId, creditsSeconds)
      }
      break
    }

    case 'payment_intent.payment_failed': {
      // Auto-refill card declined — disable auto-refill so we don't retry blindly.
      const pi = event.data.object as Stripe.PaymentIntent
      if (pi.metadata?.auto_refill !== 'true') break
      const userId = pi.metadata?.user_id
      if (userId) {
        await supabase
          .from('profiles')
          .update({ auto_refill_enabled: false })
          .eq('id', userId)
      }
      break
    }
  }

  return NextResponse.json({ received: true })
}
