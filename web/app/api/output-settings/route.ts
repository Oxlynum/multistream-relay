import { createServerClient } from '@/lib/supabase'
import { authenticateUserOrAgent } from '@/lib/agent-auth'
import type { OutputSettingsMap, OutputSettings } from '@/lib/billing'

const VALID_RESOLUTIONS = new Set(['720p', '1080p', '1440p'])
const KNOWN_PLATFORMS = new Set(['twitch', 'kick', 'youtube', 'tiktok'])

const BITRATE_LIMITS: Record<string, { min: number; max: number }> = {
  twitch:  { min: 2500, max: 8000 },
  kick:    { min: 2500, max: 8000 },
  youtube: { min: 2500, max: 8000 },
  tiktok:  { min: 1000, max: 4500 },
}

export async function GET(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServerClient()
  const { data: profile } = await supabase
    .from('profiles')
    .select('output_settings, has_2k_addon, primary_platform')
    .eq('id', userId)
    .single()

  return Response.json({
    output_settings: (profile?.output_settings as OutputSettingsMap) ?? {},
    has_2k_addon: profile?.has_2k_addon ?? false,
    primary_platform: profile?.primary_platform ?? null,
  })
}

export async function PATCH(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as Record<string, OutputSettings>

  // primary_platform is a sibling scalar (not a per-platform entry) — validate it separately.
  const primaryProvided = body != null && typeof body === 'object' && 'primary_platform' in body
  const primaryPlatform = primaryProvided ? (body as Record<string, unknown>).primary_platform : undefined
  if (
    primaryProvided &&
    primaryPlatform !== null &&
    (typeof primaryPlatform !== 'string' || !KNOWN_PLATFORMS.has(primaryPlatform))
  ) {
    return Response.json({ error: 'Invalid primary_platform' }, { status: 400 })
  }

  // Validate and sanitize the incoming per-platform settings
  const sanitized: OutputSettingsMap = {}
  // 1440p (2K) output requires the 2K add-on — checked against the profile below so a
  // direct API call can't set it (the dashboard UI also gates this). Without the gate
  // the GPU would NVENC-encode 2K for a non-entitled user (real compute + egress cost).
  let requested1440 = false
  for (const [platform, settings] of Object.entries(body)) {
    if (!KNOWN_PLATFORMS.has(platform)) continue
    if (typeof settings !== 'object' || settings === null) continue

    const entry: OutputSettings = {}

    if (settings.resolution !== undefined) {
      if (!VALID_RESOLUTIONS.has(settings.resolution)) {
        return Response.json({ error: `Invalid resolution for ${platform}` }, { status: 400 })
      }
      if (settings.resolution === '1440p') requested1440 = true
      entry.resolution = settings.resolution
    }

    if (settings.bitrate_kbps !== undefined) {
      const n = Math.round(Number(settings.bitrate_kbps))
      const limits = BITRATE_LIMITS[platform] ?? { min: 500, max: 8000 }
      if (isNaN(n)) {
        return Response.json({ error: `Invalid bitrate for ${platform}` }, { status: 400 })
      }
      entry.bitrate_kbps = Math.max(limits.min, Math.min(limits.max, n))
    }

    sanitized[platform] = entry
  }

  if (Object.keys(sanitized).length === 0 && !primaryProvided) {
    return Response.json({ error: 'No valid settings provided' }, { status: 400 })
  }

  const supabase = createServerClient()

  // Merge with existing settings (don't overwrite platforms not in the request)
  const { data: profile } = await supabase
    .from('profiles')
    .select('output_settings, has_2k_addon')
    .eq('id', userId)
    .single()

  // Gate 2K output on the add-on, server-side (unbypassable by a crafted request).
  if (requested1440 && !(profile?.has_2k_addon ?? false)) {
    return Response.json(
      { error: '1440p (2K) output requires the 2K add-on' },
      { status: 403 },
    )
  }

  const existing = (profile?.output_settings as OutputSettingsMap) ?? {}
  const merged = { ...existing, ...sanitized }

  const updatePayload: Record<string, unknown> = { output_settings: merged }
  if (primaryProvided) updatePayload.primary_platform = primaryPlatform

  const { error } = await supabase
    .from('profiles')
    .update(updatePayload)
    .eq('id', userId)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({
    ok: true,
    output_settings: merged,
    ...(primaryProvided ? { primary_platform: primaryPlatform } : {}),
  })
}
