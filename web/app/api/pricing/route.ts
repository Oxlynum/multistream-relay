import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'
import {
  buildBillingContext,
  buildPricingBreakdown,
  secondsRemaining,
  type OutputSettingsMap,
} from '@/lib/billing'

// Returns a live pricing breakdown for the user's current platform configuration.
// Used by the settings UI to show per-output costs and the total burn rate.
export async function GET(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServerClient()

  const [{ data: platforms }, { data: profile }] = await Promise.all([
    supabase
      .from('platform_connections')
      .select('platform, orientation, enabled')
      .eq('user_id', userId),
    supabase
      .from('profiles')
      .select('streaming_credits, output_settings, has_2k_addon')
      .eq('id', userId)
      .single(),
  ])

  const outputSettings: OutputSettingsMap = (profile?.output_settings as OutputSettingsMap) ?? {}
  const has2kAddon = profile?.has_2k_addon ?? false
  const credits = parseFloat(profile?.streaming_credits ?? '0') || 0

  const ctx = buildBillingContext(
    (platforms ?? []) as Array<{ platform: string; orientation: string; enabled: boolean }>,
    outputSettings,
    has2kAddon,
    true, // compute as-if streaming to show live rate
  )

  const breakdown = buildPricingBreakdown(ctx)
  const remaining = secondsRemaining(credits, breakdown.total_tokens_per_hr)

  return Response.json({
    ...breakdown,
    credits,
    estimated_seconds_remaining: remaining,
    has_2k_addon: has2kAddon,
  })
}
