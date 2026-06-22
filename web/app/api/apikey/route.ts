import { createServerClient } from '@/lib/supabase'
import { generateApiKey, hashApiKey } from '@/lib/agent-auth'
import { checkRateLimit } from '@/lib/rate-limit'

// GET  — check whether a user API key exists
// POST — generate (or regenerate) a user API key; returns the raw key ONCE
export async function GET(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await supabase
    .from('agent_api_keys')
    .select('id, created_at')
    .eq('user_id', user.id)
    .eq('label', 'user')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return Response.json({ exists: !!data, created_at: data?.created_at ?? null })
}

export async function POST(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  if (!(await checkRateLimit(`apikey:${user.id}`, 5, 60))) {
    return Response.json({ error: 'Too many requests. Slow down.' }, { status: 429 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('stripe_payment_method_id')
    .eq('id', user.id)
    .single()

  if (!profile?.stripe_payment_method_id) {
    return Response.json({ error: 'A payment method is required to generate an API key.' }, { status: 403 })
  }

  const rawKey = generateApiKey()
  const keyHash = hashApiKey(rawKey)

  // Delete all existing user-label keys, then insert the new one.
  // Keeps pod-label keys (ephemeral per-session) untouched.
  await supabase
    .from('agent_api_keys')
    .delete()
    .eq('user_id', user.id)
    .eq('label', 'user')

  await supabase.from('agent_api_keys').insert({
    user_id: user.id,
    key_hash: keyHash,
    label: 'user',
  })

  // Return the raw key — it cannot be recovered after this response.
  return Response.json({ api_key: rawKey })
}
