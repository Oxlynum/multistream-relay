import { createServerClient } from '@/lib/supabase'
import { stripe } from '@/lib/stripe'

// Creates a Stripe Billing Portal session so the user can update their card,
// view invoices, or cancel without touching our code.
export async function POST(request: Request) {
  const supabase = createServerClient()
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', user.id)
    .single()

  if (!profile?.stripe_customer_id) {
    return Response.json({ error: 'No billing account found. Buy credits first.' }, { status: 400 })
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/credits`,
  })

  return Response.json({ url: session.url })
}
