import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'
import { decryptSecret } from '@/lib/crypto'
import { checkTwitchHevcEligibility } from '@/lib/twitch-eligibility'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ platform: string }> }
) {
  const supabase = createServerClient()

  const authHeader = request.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  const { data: { user } } = await supabase.auth.getUser(token ?? '')
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { platform } = await params

  const { error } = await supabase
    .from('platform_connections')
    .delete()
    .eq('user_id', user.id)
    .eq('platform', platform)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ platform: string }> }
) {
  const supabase = createServerClient()

  const userId = await authenticateUserOrAgent(request)
  if (!userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { platform } = await params
  const body = await request.json().catch(() => ({}))

  // Twitch-only: re-probe HEVC/Enhanced-Broadcasting eligibility without re-entering
  // the key (e.g. after the user becomes an Affiliate). Decrypts the stored key,
  // asks Twitch, and updates the eligibility columns.
  if (platform === 'twitch' && body.recheck_eligibility === true) {
    const { data: row } = await supabase
      .from('platform_connections')
      .select('stream_key_encrypted')
      .eq('user_id', userId)
      .eq('platform', 'twitch')
      .single()
    if (!row?.stream_key_encrypted) {
      return Response.json({ error: 'No Twitch connection to check' }, { status: 404 })
    }
    const elig = await checkTwitchHevcEligibility(decryptSecret(row.stream_key_encrypted))
    await supabase
      .from('platform_connections')
      .update({
        twitch_hevc_eligible: elig.hevcEligible,
        twitch_max_height: elig.maxHeight,
        twitch_eligibility_checked_at: elig.checkedAt,
      })
      .eq('user_id', userId)
      .eq('platform', 'twitch')
    return Response.json({ ok: true, ...elig })
  }

  const updates: Record<string, unknown> = {}
  if ('enabled' in body) updates.enabled = !!body.enabled
  if ('bitrate_kbps' in body) {
    updates.bitrate_kbps = Math.max(500, Math.min(8000, Math.round(Number(body.bitrate_kbps)) || 0))
  }
  if ('fps' in body) {
    const fps = Math.round(Number(body.fps))
    updates.fps = [30, 60].includes(fps) ? fps : 60
  }
  if ('orientation' in body && (body.orientation === 'landscape' || body.orientation === 'portrait')) {
    updates.orientation = body.orientation
  }
  // The user's choice to use HEVC passthrough — only honored for Twitch (the
  // agent ignores it unless twitch_hevc_eligible is also true).
  if (platform === 'twitch' && 'twitch_use_passthrough' in body) {
    updates.twitch_use_passthrough = !!body.twitch_use_passthrough
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: 'No updatable fields provided' }, { status: 400 })
  }

  const { error } = await supabase
    .from('platform_connections')
    .update(updates)
    .eq('user_id', userId)
    .eq('platform', platform)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true })
}
