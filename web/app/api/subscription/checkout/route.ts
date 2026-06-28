import { createServerClient } from '@/lib/supabase'
import { stripe, SUBSCRIPTION_PRICE_ID } from '@/lib/stripe'
import { checkRateLimit } from '@/lib/rate-limit'

// POST /api/subscription/checkout — start a recurring monthly subscription via Stripe
// Checkout. The webhook (customer.subscription.* + invoice.paid) flips profiles.plan to
// 'subscription' and grants the monthly token allotment.
export async function POST(request: Request) {
  const supabase = createServerClient()

  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  if (!SUBSCRIPTION_PRICE_ID) {
    return Response.json({ error: 'subscription_not_configured', message: 'Subscriptions are not set up.' }, { status: 503 })
  }
  if (!(await checkRateLimit(`sub-checkout:${user.id}`, 10, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id, plan, subscription_status, stripe_subscription_id')
    .eq('id', user.id)
    .single()

  // Block a second subscription whenever an existing one is still live (incl. past_due —
  // Stripe is retrying it, not canceled). Otherwise a past_due user could create a
  // duplicate subscription and be double-charged. They should fix payment via the portal.
  if (
    profile?.plan === 'subscription' &&
    profile?.stripe_subscription_id &&
    profile?.subscription_status !== 'canceled'
  ) {
    return Response.json(
      { error: 'already_subscribed', message: 'You already have a subscription. Manage it from the billing portal.' },
      { status: 409 },
    )
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: profile?.stripe_customer_id ?? undefined,
    customer_email: profile?.stripe_customer_id ? undefined : user.email,
    line_items: [{ price: SUBSCRIPTION_PRICE_ID, quantity: 1 }],
    // user_id rides on BOTH the session AND the subscription so the webhook can map
    // customer.subscription.* / invoice.paid events back to the user.
    metadata: { user_id: user.id },
    subscription_data: { metadata: { user_id: user.id } },
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/credits?subscribed=1`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/credits`,
  })

  return Response.json({ url: session.url })
}
