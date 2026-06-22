import { createServerClient } from '@/lib/supabase'
import { stripe, HOURLY_PRICE_ID, hoursToSeconds } from '@/lib/stripe'
import { creditPaymentOnce } from '@/lib/billing'

// GET — return current auto-refill settings + whether a payment method is saved.
export async function GET(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('auto_refill_enabled, auto_refill_hours, stripe_customer_id, stripe_payment_method_id')
    .eq('id', user.id)
    .single()

  return Response.json({
    enabled: profile?.auto_refill_enabled ?? false,
    hours: profile?.auto_refill_hours ?? 10,
    has_payment_method: !!profile?.stripe_payment_method_id,
  })
}

// PATCH — update auto-refill settings (enabled, hours).
export async function PATCH(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const { enabled, hours } = body as { enabled?: boolean; hours?: number }

  const updates: Record<string, unknown> = {}
  if (typeof enabled === 'boolean') updates.auto_refill_enabled = enabled
  if (hours !== undefined) {
    const h = Math.round(Number(hours))
    if (h < 1 || h > 500) return Response.json({ error: 'hours must be 1–500' }, { status: 400 })
    updates.auto_refill_hours = h
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 })
  }

  // If enabling, verify they have a saved payment method.
  if (updates.auto_refill_enabled === true) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_payment_method_id')
      .eq('id', user.id)
      .single()

    if (!profile?.stripe_payment_method_id) {
      return Response.json({ error: 'no_payment_method', message: 'Buy credits once to save a payment method, then enable auto-refill.' }, { status: 400 })
    }
  }

  await supabase.from('profiles').update(updates).eq('id', user.id)
  return Response.json({ ok: true })
}

// POST /api/credits/auto-refill/trigger — internal, called by agent status handler.
// Charges the saved payment method for the user's configured refill amount.
export async function triggerAutoRefill(userId: string): Promise<boolean> {
  const supabase = createServerClient()

  const { data: profile } = await supabase
    .from('profiles')
    .select('auto_refill_enabled, auto_refill_hours, stripe_customer_id, stripe_payment_method_id, streaming_credits_seconds')
    .eq('id', userId)
    .single()

  if (!profile?.auto_refill_enabled) return false
  if (!profile.stripe_customer_id || !profile.stripe_payment_method_id) return false
  // Don't double-refill if balance already climbed above threshold (race guard).
  if ((profile.streaming_credits_seconds ?? 0) > 3600) return false

  const hours = profile.auto_refill_hours ?? 10
  const amountCents = hours * 200 // $2/hr

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: profile.stripe_customer_id,
      payment_method: profile.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      description: `SlimCast auto-refill: ${hours} hours`,
      metadata: {
        user_id: userId,
        hours: hours.toString(),
        credits_seconds: hoursToSeconds(hours).toString(),
        auto_refill: 'true',
      },
    })

    if (paymentIntent.status === 'succeeded') {
      // Credit immediately so the live stream isn't killed waiting on the
      // webhook. Keyed on the payment_intent id, so the webhook's later
      // payment_intent.succeeded for the same charge is a no-op (no double).
      await creditPaymentOnce(paymentIntent.id, userId, hoursToSeconds(hours))
      return true
    }
  } catch {
    // Card declined or requires_action — disable auto-refill so we don't keep retrying.
    await supabase
      .from('profiles')
      .update({ auto_refill_enabled: false })
      .eq('id', userId)
  }

  return false
}
