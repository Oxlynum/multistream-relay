import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'
import {
  buildBillingContext,
  buildPricingBreakdown,
  secondsRemaining,
  spendableTokens,
  type OutputSettingsMap,
  type BillingPlatformRow,
  type Plan,
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
      .select('platform, orientation, enabled, twitch_hevc_eligible, twitch_use_passthrough')
      .eq('user_id', userId),
    supabase
      .from('profiles')
      .select('plan, allotment_tokens, streaming_credits, output_settings, has_2k_addon')
      .eq('id', userId)
      .single(),
  ])

  const outputSettings: OutputSettingsMap = (profile?.output_settings as OutputSettingsMap) ?? {}
  const has2kAddon = profile?.has_2k_addon ?? false
  const plan: Plan = profile?.plan === 'subscription' ? 'subscription' : 'payg'
  const credits = spendableTokens(profile)

  const ctx = buildBillingContext(
    (platforms ?? []) as unknown as BillingPlatformRow[],
    outputSettings,
    has2kAddon,
    true, // compute as-if streaming to show live rate
  )

  const breakdown = buildPricingBreakdown(ctx, plan)
  const remaining = secondsRemaining(credits, breakdown.total_tokens_per_hr)

  return Response.json({
    ...breakdown,
    credits,
    plan,
    allotment_tokens: parseFloat(String(profile?.allotment_tokens ?? '0')) || 0,
    purchased_tokens: parseFloat(String(profile?.streaming_credits ?? '0')) || 0,
    estimated_seconds_remaining: remaining,
    has_2k_addon: has2kAddon,
  })
}
