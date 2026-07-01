// Platform OAuth helpers: state signing, token refresh, per-platform configs.

import { createHmac, createHash, randomBytes } from 'crypto'
import { encryptSecret, decryptSecret } from '@/lib/crypto'
import { createServerClient } from '@/lib/supabase'

// ---------------------------------------------------------------------------
// CSRF state
// ---------------------------------------------------------------------------

function stateSecret(): string {
  const s = process.env.STREAM_KEY_SECRET
  if (!s) throw new Error('STREAM_KEY_SECRET not set')
  return s
}

/**
 * Create a signed OAuth state token encoding the user + platform.
 * Format (base64url): userId:platform:timestamp:nonce:hmac
 */
export function createOAuthState(userId: string, platform: string): string {
  const nonce = randomBytes(8).toString('hex')
  const ts = Date.now().toString()
  const payload = `${userId}:${platform}:${ts}:${nonce}`
  const sig = createHmac('sha256', stateSecret()).update(payload).digest('hex')
  return Buffer.from(`${payload}:${sig}`).toString('base64url')
}

/**
 * Verify a state token and return { userId, platform }, or null if invalid/expired.
 * Freshness window: 15 minutes.
 */
export function verifyOAuthState(state: string): { userId: string; platform: string } | null {
  try {
    const decoded = Buffer.from(state, 'base64url').toString('utf8')
    const parts = decoded.split(':')
    if (parts.length !== 5) return null
    const [userId, platform, ts, nonce, sig] = parts
    if (Date.now() - Number(ts) > 15 * 60 * 1000) return null
    const payload = `${userId}:${platform}:${ts}:${nonce}`
    const expected = createHmac('sha256', stateSecret()).update(payload).digest('hex')
    // Constant-time compare to avoid timing attacks
    const sigBuf = Buffer.from(sig, 'hex')
    const expBuf = Buffer.from(expected, 'hex')
    if (sigBuf.length !== expBuf.length) return null
    let diff = 0
    for (let i = 0; i < sigBuf.length; i++) diff |= sigBuf[i] ^ expBuf[i]
    if (diff !== 0) return null
    return { userId, platform }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — required by OAuth-2.1 providers (Kick)
// ---------------------------------------------------------------------------

/**
 * Derive the PKCE code_verifier deterministically from the signed state token.
 * This keeps the flow stateless (no verifier to persist between authorize and
 * callback) while never transmitting the verifier — only its S256 challenge
 * goes to the provider, and the state (which IS public) can't yield the verifier
 * without STREAM_KEY_SECRET. base64url(HMAC-SHA256) = 43 chars, all within the
 * RFC 7636 unreserved verifier alphabet.
 */
export function deriveCodeVerifier(state: string): string {
  return createHmac('sha256', stateSecret()).update(`pkce:${state}`).digest('base64url')
}

/** S256 code_challenge = base64url(SHA-256(code_verifier)). */
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

// ---------------------------------------------------------------------------
// Per-platform OAuth config
// ---------------------------------------------------------------------------

export interface OAuthConfig {
  name: string
  authUrl: string
  tokenUrl: string
  scopes: string[]
  clientId: () => string | undefined
  clientSecret: () => string | undefined
  /** Provider mandates PKCE (S256) on the authorization-code flow (Kick / OAuth 2.1). */
  pkce?: boolean
}

export const OAUTH_CONFIGS: Record<string, OAuthConfig> = {
  twitch: {
    name: 'Twitch',
    authUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    scopes: ['channel:read:stream_key'],
    clientId: () => process.env.TWITCH_CLIENT_ID,
    clientSecret: () => process.env.TWITCH_CLIENT_SECRET,
  },
  youtube: {
    name: 'YouTube',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/youtube'],
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  kick: {
    name: 'Kick',
    // Kick OAuth 2.1 — auth/token live on id.kick.com; API on api.kick.com.
    authUrl: 'https://id.kick.com/oauth/authorize',
    tokenUrl: 'https://id.kick.com/oauth/token',
    // streamkey:read → stream URL + key; channel:read → channel object; user:read → identity.
    scopes: ['user:read', 'channel:read', 'streamkey:read'],
    clientId: () => process.env.KICK_CLIENT_ID,
    clientSecret: () => process.env.KICK_CLIENT_SECRET,
    pkce: true,
  },
  facebook: {
    name: 'Facebook',
    authUrl: 'https://www.facebook.com/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    scopes: ['publish_video'],
    clientId: () => process.env.FACEBOOK_APP_ID,
    clientSecret: () => process.env.FACEBOOK_APP_SECRET,
  },
}

export function getOAuthConfig(platform: string): OAuthConfig | null {
  return OAUTH_CONFIGS[platform] ?? null
}

export function callbackUrl(platform: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  return `${base}/api/oauth/${platform}/callback`
}

// ---------------------------------------------------------------------------
// Token exchange + refresh
// ---------------------------------------------------------------------------

export interface TokenSet {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

export async function exchangeCode(platform: string, code: string, codeVerifier?: string): Promise<TokenSet> {
  const cfg = getOAuthConfig(platform)
  if (!cfg) throw new Error(`Unknown platform: ${platform}`)

  const clientId = cfg.clientId()
  const clientSecret = cfg.clientSecret()
  if (!clientId || !clientSecret) throw new Error(`OAuth not configured for ${platform}`)

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: callbackUrl(platform),
    client_id: clientId,
    client_secret: clientSecret,
  })
  // PKCE providers (Kick) require the verifier that matches the authorize challenge.
  if (codeVerifier) params.set('code_verifier', codeVerifier)

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Token exchange failed: ${err}`)
  }

  return res.json() as Promise<TokenSet>
}

export async function refreshAccessToken(platform: string, encryptedRefreshToken: string): Promise<TokenSet> {
  const cfg = getOAuthConfig(platform)
  if (!cfg) throw new Error(`Unknown platform: ${platform}`)

  const clientId = cfg.clientId()
  const clientSecret = cfg.clientSecret()
  if (!clientId || !clientSecret) throw new Error(`OAuth not configured for ${platform}`)

  const refreshToken = decryptSecret(encryptedRefreshToken)
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  })

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Token refresh failed: ${err}`)
  }

  return res.json() as Promise<TokenSet>
}

// ---------------------------------------------------------------------------
// Per-platform stream key fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch the Twitch stream key for the authenticated user.
 * Returns { streamKey } — Twitch stream keys are static and rarely change.
 */
export async function fetchTwitchStreamKey(accessToken: string): Promise<string> {
  const clientId = process.env.TWITCH_CLIENT_ID
  if (!clientId) throw new Error('TWITCH_CLIENT_ID not set')

  const res = await fetch('https://api.twitch.tv/helix/streams/key', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': clientId,
    },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Twitch stream key fetch failed: ${err}`)
  }

  const json = await res.json() as { data?: Array<{ stream_key: string }> }
  const key = json.data?.[0]?.stream_key
  if (!key) throw new Error('No stream key returned by Twitch API')
  return key
}

/**
 * Get or create a YouTube live stream resource and return its RTMP ingest key.
 * YouTube stream keys are persistent and reusable across sessions.
 */
export async function fetchYouTubeStreamKey(accessToken: string): Promise<{ rtmpUrl: string; streamKey: string }> {
  // List existing live streams first
  const listRes = await fetch(
    'https://www.googleapis.com/youtube/v3/liveStreams?part=cdn,snippet&mine=true&maxResults=5',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )

  if (!listRes.ok) {
    const err = await listRes.text()
    throw new Error(`YouTube liveStreams.list failed: ${err}`)
  }

  const listJson = await listRes.json() as {
    items?: Array<{
      cdn?: { ingestionInfo?: { ingestionAddress?: string; streamName?: string } }
      snippet?: { title?: string }
    }>
  }

  // Use the first existing stream
  const existing = listJson.items?.find(
    s => s.cdn?.ingestionInfo?.streamName && s.cdn?.ingestionInfo?.ingestionAddress
  )
  if (existing) {
    return {
      rtmpUrl: existing.cdn!.ingestionInfo!.ingestionAddress!,
      streamKey: existing.cdn!.ingestionInfo!.streamName!,
    }
  }

  // No existing stream — create one
  const createRes = await fetch(
    'https://www.googleapis.com/youtube/v3/liveStreams?part=cdn,snippet',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        snippet: { title: 'SlimCast Stream' },
        cdn: { ingestionType: 'rtmp', resolution: '1080p', frameRate: '60fps' },
      }),
    }
  )

  if (!createRes.ok) {
    const err = await createRes.text()
    throw new Error(`YouTube liveStreams.insert failed: ${err}`)
  }

  const created = await createRes.json() as {
    cdn?: { ingestionInfo?: { ingestionAddress?: string; streamName?: string } }
  }

  const rtmpUrl = created.cdn?.ingestionInfo?.ingestionAddress
  const streamKey = created.cdn?.ingestionInfo?.streamName
  if (!rtmpUrl || !streamKey) throw new Error('YouTube API did not return ingest info')

  return { rtmpUrl, streamKey }
}

/**
 * Fetch the Kick stream URL + key for the authenticated user.
 * GET /public/v1/channels with no params returns the caller's own channel
 * (requires the streamkey:read scope for the nested stream.key/url).
 * Kick stream URLs + keys are persistent and reusable across sessions.
 */
export async function fetchKickStreamKey(accessToken: string): Promise<{ rtmpUrl: string; streamKey: string }> {
  const res = await fetch('https://api.kick.com/public/v1/channels', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Kick channels fetch failed: ${err}`)
  }

  const json = await res.json() as {
    data?: Array<{ stream?: { key?: string; url?: string } }>
  }

  const stream = json.data?.[0]?.stream
  if (!stream?.key || !stream?.url) {
    throw new Error('Kick API did not return a stream key/url (streamkey:read scope granted?)')
  }
  return { rtmpUrl: stream.url, streamKey: stream.key }
}

/**
 * Create an UNPUBLISHED Facebook live video and return its RTMP URL + key.
 * The key is the portion of secure_stream_url after the last /rtmp/ segment.
 * Facebook keys are long-lived until the video is deleted or expires.
 */
export async function fetchFacebookStreamKey(accessToken: string): Promise<{ rtmpUrl: string; streamKey: string }> {
  const res = await fetch('https://graph.facebook.com/v18.0/me/live_videos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: 'UNPUBLISHED',
      title: 'SlimCast Live',
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Facebook live_videos create failed: ${err}`)
  }

  const json = await res.json() as { secure_stream_url?: string; stream_url?: string }
  const rawUrl = json.secure_stream_url ?? json.stream_url
  if (!rawUrl) throw new Error('Facebook API did not return a stream URL')

  // secure_stream_url format: rtmps://live-api-s.facebook.com:443/rtmp/<key>?params
  // Split at /rtmp/ to separate base URL from key
  const rtmpBase = 'rtmps://live-api-s.facebook.com:443/rtmp/'
  const rtmpIdx = rawUrl.indexOf('/rtmp/')
  if (rtmpIdx === -1) throw new Error(`Unexpected Facebook stream URL format: ${rawUrl}`)

  const rtmpUrl = rawUrl.slice(0, rtmpIdx + '/rtmp/'.length)
  const streamKey = rawUrl.slice(rtmpIdx + '/rtmp/'.length)

  return { rtmpUrl, streamKey }
}

// ---------------------------------------------------------------------------
// Token persistence helpers
// ---------------------------------------------------------------------------

export async function saveOAuthTokens(
  userId: string,
  platform: string,
  tokens: TokenSet,
): Promise<void> {
  const supabase = createServerClient()
  const now = new Date()
  const expiresAt = tokens.expires_in
    ? new Date(now.getTime() + tokens.expires_in * 1000)
    : null

  await supabase.from('platform_tokens').upsert({
    user_id: userId,
    platform,
    access_token: encryptSecret(tokens.access_token),
    refresh_token: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
    expires_at: expiresAt?.toISOString() ?? null,
    scope: tokens.scope ?? null,
    connected_at: now.toISOString(),
  }, { onConflict: 'user_id,platform' })
}

/**
 * Get the stored access token for a platform, refreshing if needed.
 * Returns null if no token stored or if refresh fails.
 */
export async function getValidAccessToken(userId: string, platform: string): Promise<string | null> {
  const supabase = createServerClient()
  const { data } = await supabase
    .from('platform_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', userId)
    .eq('platform', platform)
    .single()

  if (!data) return null

  const accessToken = decryptSecret(data.access_token)

  // Check expiry (with a 60-second buffer)
  if (data.expires_at && data.refresh_token) {
    const expiresAt = new Date(data.expires_at).getTime()
    if (Date.now() > expiresAt - 60_000) {
      try {
        const fresh = await refreshAccessToken(platform, data.refresh_token)
        await saveOAuthTokens(userId, platform, fresh)
        return fresh.access_token
      } catch {
        return null
      }
    }
  }

  return accessToken
}
