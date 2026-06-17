import { createServerClient } from './supabase'
import { randomBytes } from 'crypto'

export function generateKey(): string {
  // Format: SC-XXXX-XXXX-XXXX-XXXX
  const hex = randomBytes(8).toString('hex').toUpperCase()
  return `SC-${hex.slice(0,4)}-${hex.slice(4,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}`
}

export async function createLicenseKey(userId: string, tier: 'free' | 'pro') {
  const supabase = createServerClient()
  const key = generateKey()
  const { data, error } = await supabase
    .from('license_keys')
    .insert({ user_id: userId, key, tier, active: true })
    .select()
    .single()
  if (error) throw error
  return data
}
