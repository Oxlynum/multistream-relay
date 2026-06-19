import { createServerClient } from '@/lib/supabase'
import { createHash } from 'crypto'

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Validate a raw API key from Authorization header and return the user_id. */
export async function authenticateAgent(request: Request): Promise<string | null> {
  const detail = await authenticateAgentDetailed(request)
  return detail?.userId ?? null
}

/**
 * Like authenticateAgent but also returns the key's label ('pod' | 'user').
 * Billing only happens on the 'pod' agent's heartbeat — the dashboard/OBS dock
 * authenticate with the 'user' key and must not also deduct credits.
 */
export async function authenticateAgentDetailed(
  request: Request,
): Promise<{ userId: string; label: string } | null> {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null

  const rawKey = auth.slice(7).trim()
  if (!rawKey) return null

  const keyHash = hashApiKey(rawKey)
  const supabase = createServerClient()

  const { data } = await supabase
    .from('agent_api_keys')
    .select('user_id, label')
    .eq('key_hash', keyHash)
    .single()

  if (!data?.user_id) return null
  return { userId: data.user_id, label: data.label ?? 'user' }
}

/**
 * Resolve a user from either an agent API key (OBS plugin) or a Supabase
 * session JWT (dashboard) — both arrive in the Authorization: Bearer header.
 * Used by the GPU lifecycle + credit routes that both surfaces call.
 */
export async function authenticateUserOrAgent(request: Request): Promise<string | null> {
  // OBS plugin: raw agent key hashed against agent_api_keys.
  const agentUserId = await authenticateAgent(request)
  if (agentUserId) return agentUserId

  // Dashboard: Supabase JWT.
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  return user?.id ?? null
}
