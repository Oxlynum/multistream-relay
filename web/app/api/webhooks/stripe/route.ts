import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'
import { createServerClient } from '@/lib/supabase'
import { creditPaymentOnce, grantSubscriptionAllotment, SUB_ALLOTMENT_TOKENS, SUB_ALLOTMENT_CAP } from '@/lib/billing'
import type { SupabaseClient } from '@supabase/supabase-js'
import Stripe from 'stripe'

// Map a Stripe event back to our user: prefer the metadata user_id we stamp on the
// subscription/session, fall back to looking the profile up by stripe_customer_id.
async function resolveUserId(
  supabase: SupabaseClient,
  metadataUserId: string | undefined | null,
  customerId: string | undefined | null,
): Promise<string | null> {
  if (metadataUserId) return metadataUserId
  if (customerId) {
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle()
    return (data?.id as string) ?? null
  }
  return null
}

// Subscription statuses that still grant subscriber benefits (cheaper passthrough +
// future allotment grants). past_due is a short payment-retry grace, not a downgrade.
const SUBSCRIBER_STATUSES = new Set(['active', 'trialing', 'past_due'])

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

      // Subscription checkout completion is handled by customer.subscription.* +
      // invoice.paid below — nothing to credit here.
      if (session.mode === 'subscription') {
        if (userId && session.customer) {
          await supabase
            .from('profiles')
            .update({ stripe_customer_id: session.customer as string })
            .eq('id', userId)
            .is('stripe_customer_id', null)
        }
        break
      }

      if (session.mode !== 'payment' || session.payment_status !== 'paid') break

      const tokens = parseFloat(session.metadata?.credits_tokens ?? '0') || 0
      // Idempotent on the payment_intent id: a Stripe webhook retry (or the
      // session firing twice) can never double-credit.
      const payId = (session.payment_intent as string) ?? session.id
      if (userId && tokens > 0) {
        await creditPaymentOnce(payId, userId, tokens)
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
      const tokens = parseFloat(pi.metadata?.credits_tokens ?? '0') || 0
      // Keyed on the payment_intent id, so this is a no-op if the auto-refill
      // path already credited it — and the backstop if that path failed.
      if (userId && tokens > 0) {
        await creditPaymentOnce(pi.id, userId, tokens)
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

    // ── Subscription lifecycle (Phase 3) ─────────────────────────────────────
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      // Defensive view — the dahlia API shapes some of these differently.
      const sub = event.data.object as unknown as {
        id: string
        status: string
        customer?: string | { id?: string }
        metadata?: Record<string, string>
        current_period_end?: number
        items?: { data?: Array<{ price?: { id?: string }; current_period_end?: number }> }
      }
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
      const userId = await resolveUserId(supabase, sub.metadata?.user_id, customerId)
      if (!userId) break

      const isSubscriber = SUBSCRIBER_STATUSES.has(sub.status)
      const priceId = sub.items?.data?.[0]?.price?.id ?? null
      const periodEndUnix = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null

      await supabase
        .from('profiles')
        .update({
          plan: isSubscriber ? 'subscription' : 'payg',
          subscription_status: sub.status,
          subscription_price_id: priceId,
          subscription_current_period_end: periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null,
          stripe_subscription_id: sub.id,
          ...(customerId ? { stripe_customer_id: customerId } : {}),
        })
        .eq('id', userId)
      break
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as unknown as {
        id: string
        customer?: string | { id?: string }
        metadata?: Record<string, string>
      }
      const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id
      const userId = await resolveUserId(supabase, sub.metadata?.user_id, customerId)
      if (!userId) break
      // Revert to PAYG but KEEP any already-granted allotment (they paid for it).
      await supabase
        .from('profiles')
        .update({ plan: 'payg', subscription_status: 'canceled', stripe_subscription_id: null })
        .eq('id', userId)
      break
    }

    case 'invoice.paid': {
      const inv = event.data.object as unknown as {
        id?: string
        billing_reason?: string | null
        subscription?: string | { id?: string } | null
        customer?: string | { id?: string } | null
        parent?: { subscription_details?: { subscription?: string } }
      }
      const subId =
        (typeof inv.subscription === 'string' ? inv.subscription : inv.subscription?.id) ??
        inv.parent?.subscription_details?.subscription ??
        null
      if (!subId || !inv.id) break // not a subscription invoice → no allotment

      // Only the initial + recurring cycle invoices grant the monthly allotment. The
      // allowlist is authoritative: an empty/missing/unknown reason safely SKIPS the grant
      // (don't drop the negation's guard — `reason &&` would let an empty reason through).
      const reason = inv.billing_reason ?? ''
      if (!['subscription_create', 'subscription_cycle'].includes(reason)) break

      let metaUserId: string | undefined
      try {
        const sub = await stripe.subscriptions.retrieve(subId)
        metaUserId = sub.metadata?.user_id
      } catch { /* fall back to customer lookup */ }
      const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id
      const userId = await resolveUserId(supabase, metaUserId, customerId)
      if (!userId) break

      // Idempotent on the invoice id: rollover-capped monthly allotment grant.
      await grantSubscriptionAllotment(inv.id, userId, SUB_ALLOTMENT_TOKENS, SUB_ALLOTMENT_CAP)
      break
    }

    case 'invoice.payment_failed': {
      const inv = event.data.object as unknown as { customer?: string | { id?: string } | null }
      const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id
      const userId = await resolveUserId(supabase, undefined, customerId)
      if (userId) {
        await supabase.from('profiles').update({ subscription_status: 'past_due' }).eq('id', userId)
      }
      break
    }
  }

  return NextResponse.json({ received: true })
}
