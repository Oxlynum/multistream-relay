import { createClient } from '@supabase/supabase-js'

export type Tier = 'free' | 'pro'

export interface TierLimits {
  tier: Tier
  max_outputs: number | null  // null = unlimited
  max_resolution: number | null  // null = unlimited, otherwise max height (e.g. 720)
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { tier: 'free', max_outputs: 2, max_resolution: 720 },
  pro:  { tier: 'pro',  max_outputs: null, max_resolution: null },
}

export function createServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

let _browserClient: ReturnType<typeof createClient> | null = null

export function createBrowserClient() {
  if (!_browserClient) {
    _browserClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )
  }
  return _browserClient
}
