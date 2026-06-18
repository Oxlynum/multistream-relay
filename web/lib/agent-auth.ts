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
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null

  const rawKey = auth.slice(7).trim()
  if (!rawKey) return null

  const keyHash = hashApiKey(rawKey)
  const supabase = createServerClient()

  const { data } = await supabase
    .from('agent_api_keys')
    .select('user_id')
    .eq('key_hash', keyHash)
    .single()

  return data?.user_id ?? null
}
