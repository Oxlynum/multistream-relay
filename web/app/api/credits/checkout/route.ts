import { createServerClient } from '@/lib/supabase'
import { stripe, HOURLY_PRICE_ID, hoursToTokens } from '@/lib/stripe'
import { checkRateLimit } from '@/lib/rate-limit'

export async function POST(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!(await checkRateLimit(`checkout:${user.id}`, 10, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  const body = await request.json().catch(() => ({}))
  const hours = Math.round(Number(body.hours))
  if (!hours || hours < 1 || hours > 500) {
    return Response.json({ error: 'hours must be 1–500' }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', user.id)
    .single()

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: profile?.stripe_customer_id ?? undefined,
    customer_email: profile?.stripe_customer_id ? undefined : user.email,
    // Save the payment method for auto-refill.
    payment_intent_data: {
      setup_future_usage: 'off_session',
    },
    line_items: [{ price: HOURLY_PRICE_ID, quantity: hours }],
    metadata: {
      user_id: user.id,
      hours: hours.toString(),
      credits_tokens: hoursToTokens(hours).toFixed(3),
    },
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/credits?success=1`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/credits`,
  })

  return Response.json({ url: session.url })
}
