import { createServerClient } from '@/lib/supabase'
import { stripe } from '@/lib/stripe'
import { checkRateLimit } from '@/lib/rate-limit'
import { spendableTokens, SUB_ALLOTMENT_TOKENS, SUB_ALLOTMENT_CAP } from '@/lib/billing'

async function authUser(request: Request) {
  const supabase = createServerClient()
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  return { user, supabase }
}

// GET /api/subscription — current plan + subscription state + token balances.
export async function GET(request: Request) {
  const { user, supabase } = await authUser(request)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: p } = await supabase
    .from('profiles')
    .select('plan, subscription_status, subscription_current_period_end, subscription_price_id, allotment_tokens, streaming_credits, stripe_subscription_id')
    .eq('id', user.id)
    .single()

  // cancel_at_period_end isn't mirrored locally; fetch it live if there's a sub.
  let cancelAtPeriodEnd = false
  if (p?.stripe_subscription_id) {
    try {
      const sub = await stripe.subscriptions.retrieve(p.stripe_subscription_id)
      cancelAtPeriodEnd = sub.cancel_at_period_end ?? false
    } catch { /* best-effort */ }
  }

  return Response.json({
    plan: p?.plan ?? 'payg',
    subscription_status: p?.subscription_status ?? null,
    current_period_end: p?.subscription_current_period_end ?? null,
    cancel_at_period_end: cancelAtPeriodEnd,
    allotment_tokens: parseFloat(String(p?.allotment_tokens ?? '0')) || 0,
    purchased_tokens: parseFloat(String(p?.streaming_credits ?? '0')) || 0,
    spendable_tokens: spendableTokens(p),
    monthly_allotment: SUB_ALLOTMENT_TOKENS,
    allotment_cap: SUB_ALLOTMENT_CAP,
  })
}

// POST /api/subscription — { action: 'cancel' | 'reactivate' | 'portal' }
//   cancel     → cancel at period end (keep streaming until the paid period ends)
//   reactivate → undo a pending cancel
//   portal     → Stripe billing portal URL (manage card / invoices / cancel)
export async function POST(request: Request) {
  const { user, supabase } = await authUser(request)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  if (!(await checkRateLimit(`sub-manage:${user.id}`, 20, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  const body = await request.json().catch(() => ({}))
  const action = body.action as string

  const { data: p } = await supabase
    .from('profiles')
    .select('stripe_subscription_id, stripe_customer_id')
    .eq('id', user.id)
    .single()

  if (action === 'portal') {
    if (!p?.stripe_customer_id) return Response.json({ error: 'no_customer' }, { status: 400 })
    const portal = await stripe.billingPortal.sessions.create({
      customer: p.stripe_customer_id,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/credits`,
    })
    return Response.json({ url: portal.url })
  }

  if (action === 'cancel' || action === 'reactivate') {
    if (!p?.stripe_subscription_id) return Response.json({ error: 'no_subscription' }, { status: 400 })
    await stripe.subscriptions.update(p.stripe_subscription_id, {
      cancel_at_period_end: action === 'cancel',
    })
    // The webhook (customer.subscription.updated) reconciles local state authoritatively.
    return Response.json({ ok: true, cancel_at_period_end: action === 'cancel' })
  }

  return Response.json({ error: 'unknown_action' }, { status: 400 })
}
