import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { encryptSecret } from '@/lib/crypto'
import { checkTwitchHevcEligibility } from '@/lib/twitch-eligibility'
import {
  verifyOAuthState,
  exchangeCode,
  saveOAuthTokens,
  getOAuthConfig,
  deriveCodeVerifier,
  fetchTwitchStreamKey,
  fetchYouTubeStreamKey,
  fetchKickStreamKey,
  fetchFacebookStreamKey,
  YouTubeNotEnabledError,
} from '@/lib/oauth'

const PLATFORM_DEFAULTS: Record<string, { rtmp_url: string; bitrate_kbps: number; orientation: string }> = {
  twitch:   { rtmp_url: 'rtmps://live.twitch.tv:443/app',                  bitrate_kbps: 8000, orientation: 'landscape' },
  youtube:  { rtmp_url: 'rtmp://a.rtmp.youtube.com/live2',                 bitrate_kbps: 9000, orientation: 'landscape' },
  // rtmp_url is a fallback — the Kick API returns the real ingest URL, which overrides it.
  kick:     { rtmp_url: 'rtmps://stream.kick.com/',                        bitrate_kbps: 8000, orientation: 'landscape' },
  facebook: { rtmp_url: 'rtmps://live-api-s.facebook.com:443/rtmp/',       bitrate_kbps: 4000, orientation: 'landscape' },
}

function dashboardRedirect(platform: string, error?: string): NextResponse {
  const base = process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  const url = new URL('/dashboard/platforms', base)
  if (error) {
    url.searchParams.set('oauth_error', error)
  } else {
    url.searchParams.set('connected', platform)
  }
  return NextResponse.redirect(url.toString())
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params
  const { searchParams } = request.nextUrl

  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const oauthError = searchParams.get('error')

  if (oauthError) {
    return dashboardRedirect(platform, oauthError)
  }

  if (!code || !state) {
    return dashboardRedirect(platform, 'missing_params')
  }

  const verified = verifyOAuthState(state)
  if (!verified || verified.platform !== platform) {
    return dashboardRedirect(platform, 'invalid_state')
  }

  const { userId } = verified
  const defaults = PLATFORM_DEFAULTS[platform]
  if (!defaults) {
    return dashboardRedirect(platform, 'unknown_platform')
  }

  let tokens
  try {
    // PKCE providers (Kick): re-derive the verifier from the same signed state.
    const codeVerifier = getOAuthConfig(platform)?.pkce ? deriveCodeVerifier(state) : undefined
    tokens = await exchangeCode(platform, code, codeVerifier)
  } catch (err) {
    console.error(`[oauth/callback] token exchange failed for ${platform}:`, err)
    return dashboardRedirect(platform, 'token_exchange_failed')
  }

  // Fetch stream key and upsert platform_connections
  const supabase = createServerClient()

  try {
    let streamKey: string
    let rtmpUrl = defaults.rtmp_url

    if (platform === 'twitch') {
      streamKey = await fetchTwitchStreamKey(tokens.access_token)
    } else if (platform === 'youtube') {
      const info = await fetchYouTubeStreamKey(tokens.access_token)
      streamKey = info.streamKey
      rtmpUrl = info.rtmpUrl
    } else if (platform === 'kick') {
      const info = await fetchKickStreamKey(tokens.access_token)
      streamKey = info.streamKey
      rtmpUrl = info.rtmpUrl
    } else if (platform === 'facebook') {
      const info = await fetchFacebookStreamKey(tokens.access_token)
      streamKey = info.streamKey
      rtmpUrl = info.rtmpUrl
    } else {
      return dashboardRedirect(platform, 'unknown_platform')
    }

    const { error: upsertError } = await supabase
      .from('platform_connections')
      .upsert({
        user_id: userId,
        platform,
        rtmp_url: rtmpUrl,
        stream_key_encrypted: encryptSecret(streamKey),
        bitrate_kbps: defaults.bitrate_kbps,
        fps: 60,
        orientation: defaults.orientation,
        enabled: true,
        oauth_connected: true,
      }, { onConflict: 'user_id,platform' })

    if (upsertError) throw upsertError

    // For Twitch, detect HEVC/Enhanced-Broadcasting eligibility from the fetched
    // key so the dashboard/dock can expose passthrough + 2K and the agent can
    // route eRTMP vs transcode. Best-effort.
    if (platform === 'twitch') {
      const elig = await checkTwitchHevcEligibility(streamKey)
      await supabase
        .from('platform_connections')
        .update({
          twitch_hevc_eligible: elig.hevcEligible,
          twitch_max_height: elig.maxHeight,
          twitch_eligibility_checked_at: elig.checkedAt,
        })
        .eq('user_id', userId)
        .eq('platform', 'twitch')
    }
  } catch (err) {
    console.error(`[oauth/callback] platform setup failed for ${platform}:`, err)
    if (err instanceof YouTubeNotEnabledError) {
      return dashboardRedirect(platform, 'youtube_not_enabled')
    }
    return dashboardRedirect(platform, 'setup_failed')
  }

  // Persist encrypted tokens for future refresh/revoke
  try {
    await saveOAuthTokens(userId, platform, tokens)
  } catch (err) {
    // Non-fatal: key is already stored in platform_connections
    console.error(`[oauth/callback] token save failed for ${platform}:`, err)
  }

  return dashboardRedirect(platform)
}
