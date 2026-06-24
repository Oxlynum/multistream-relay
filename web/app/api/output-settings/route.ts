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
    .select('output_settings, has_2k_addon')
    .eq('id', userId)
    .single()

  return Response.json({
    output_settings: (profile?.output_settings as OutputSettingsMap) ?? {},
    has_2k_addon: profile?.has_2k_addon ?? false,
  })
}

export async function PATCH(request: Request) {
  const userId = await authenticateUserOrAgent(request)
  if (!userId) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as Record<string, OutputSettings>

  // Validate and sanitize the incoming per-platform settings
  const sanitized: OutputSettingsMap = {}
  for (const [platform, settings] of Object.entries(body)) {
    if (!KNOWN_PLATFORMS.has(platform)) continue
    if (typeof settings !== 'object' || settings === null) continue

    const entry: OutputSettings = {}

    if (settings.resolution !== undefined) {
      if (!VALID_RESOLUTIONS.has(settings.resolution)) {
        return Response.json({ error: `Invalid resolution for ${platform}` }, { status: 400 })
      }
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

  if (Object.keys(sanitized).length === 0) {
    return Response.json({ error: 'No valid settings provided' }, { status: 400 })
  }

  const supabase = createServerClient()

  // Merge with existing settings (don't overwrite platforms not in the request)
  const { data: profile } = await supabase
    .from('profiles')
    .select('output_settings')
    .eq('id', userId)
    .single()

  const existing = (profile?.output_settings as OutputSettingsMap) ?? {}
  const merged = { ...existing, ...sanitized }

  const { error } = await supabase
    .from('profiles')
    .update({ output_settings: merged })
    .eq('id', userId)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({ ok: true, output_settings: merged })
}
