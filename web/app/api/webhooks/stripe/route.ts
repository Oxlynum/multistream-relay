import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'
import { createServerClient } from '@/lib/supabase'
import { creditPaymentOnce } from '@/lib/billing'
import Stripe from 'stripe'

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
      const userId = session.metadata?.user_id

      if (session.mode === 'setup') {
        if (userId && session.customer) {
          await supabase
            .from('profiles')
            .update({ stripe_customer_id: session.customer as string })
            .eq('id', userId)
            .is('stripe_customer_id', null)
        }
        if (userId && session.setup_intent) {
          const si = await stripe.setupIntents.retrieve(session.setup_intent as string)
          if (si.payment_method) {
            await supabase
              .from('profiles')
              .update({ stripe_payment_method_id: si.payment_method as string })
              .eq('id', userId)
          }
        }
        break
      }

      if (session.mode !== 'payment' || session.payment_status !== 'paid') break

      const creditsSeconds = parseInt(session.metadata?.credits_seconds ?? '0', 10)
      // Idempotent on the payment_intent id: a Stripe webhook retry (or the
      // session firing twice) can never double-credit.
      const payId = (session.payment_intent as string) ?? session.id
      if (userId && creditsSeconds > 0) {
        await creditPaymentOnce(payId, userId, creditsSeconds)
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
      // Keyed on the payment_intent id, so this is a no-op if the auto-refill
      // path already credited it — and the backstop if that path failed.
      if (userId && creditsSeconds > 0) {
        await creditPaymentOnce(pi.id, userId, creditsSeconds)
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
