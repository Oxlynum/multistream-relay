import { createServerClient } from '@/lib/supabase'
import { generateApiKey, hashApiKey } from '@/lib/agent-auth'

// GET  — check whether an API key exists (returns exists: bool, not the key itself)
// POST — generate (or regenerate) an API key; returns the raw key ONCE
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
    .single()

  return Response.json({ exists: !!data, created_at: data?.created_at ?? null })
}

export async function POST(request: Request) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const rawKey = generateApiKey()
  const keyHash = hashApiKey(rawKey)

  // Upsert — replaces any existing key for this user.
  await supabase.from('agent_api_keys').upsert(
    { user_id: user.id, key_hash: keyHash, created_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  )

  // Return the raw key. It cannot be recovered after this response.
  return Response.json({ api_key: rawKey })
}
