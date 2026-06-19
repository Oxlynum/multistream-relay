import { createServerClient } from '@/lib/supabase'
import { stripe } from '@/lib/stripe'

export async function POST(request: Request) {
  const supabase = createServerClient()
  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_customer_id, stripe_payment_method_id')
    .eq('id', user.id)
    .single()

  if (profile?.stripe_payment_method_id) {
    return Response.json({ url: `${process.env.NEXT_PUBLIC_APP_URL}/onboarding?step=2` })
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: profile?.stripe_customer_id ?? undefined,
    customer_email: profile?.stripe_customer_id ? undefined : user.email,
    payment_method_types: ['card'],
    metadata: {
      user_id: user.id,
      setup_type: 'initial_card_setup',
    },
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/onboarding?step=2&setup_success=1`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/onboarding?step=1&setup_cancel=1`,
  })

  return Response.json({ url: session.url })
}
