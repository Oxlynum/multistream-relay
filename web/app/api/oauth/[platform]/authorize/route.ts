import { createServerClient } from '@/lib/supabase'
import { getOAuthConfig, createOAuthState, callbackUrl, deriveCodeVerifier, codeChallengeS256 } from '@/lib/oauth'

const OAUTH_PLATFORMS = new Set(['twitch', 'youtube', 'kick', 'facebook'])

export async function GET(
  request: Request,
  { params }: { params: Promise<{ platform: string }> },
) {
  const { platform } = await params

  if (!OAUTH_PLATFORMS.has(platform)) {
    return Response.json({ error: 'Unknown platform' }, { status: 400 })
  }

  const cfg = getOAuthConfig(platform)
  if (!cfg || !cfg.clientId() || !cfg.clientSecret()) {
    return Response.json({ error: `${platform} OAuth is not configured` }, { status: 503 })
  }

  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const state = createOAuthState(user.id, platform)
  const redirect = callbackUrl(platform)

  const url = new URL(cfg.authUrl)
  url.searchParams.set('client_id', cfg.clientId()!)
  url.searchParams.set('redirect_uri', redirect)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', cfg.scopes.join(' '))
  url.searchParams.set('state', state)

  // YouTube: request offline access for a refresh token
  if (platform === 'youtube') {
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
  }

  // PKCE (Kick / OAuth 2.1): send the S256 challenge; the callback re-derives the
  // verifier from the same signed state — nothing to persist between the two hops.
  if (cfg.pkce) {
    url.searchParams.set('code_challenge', codeChallengeS256(deriveCodeVerifier(state)))
    url.searchParams.set('code_challenge_method', 'S256')
  }

  return Response.json({ url: url.toString() })
}
