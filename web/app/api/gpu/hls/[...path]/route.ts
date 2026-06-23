// Proxy MediaMTX HLS segments through Vercel so the HTTPS dashboard can load
// the live preview without a mixed-content block (pod serves plain HTTP).
//
// Auth strategy — three layers, first match wins:
//
//   1. Cookie: hls_session=<hmac>  (set by this proxy when index.m3u8 is served)
//      Safari native <video> sends same-origin cookies automatically on every
//      sub-playlist/segment request — no query-param or header needed.
//
//   2. ?hlstoken=<hmac>  (embedded in rewritten manifest URIs as fallback for
//      non-cookie environments and hls.js fetch-based loaders).
//
//   3. Full auth: Authorization: Bearer <token> or ?token=<token>
//      Supabase JWT or API key — used for index.m3u8 (the entry point) and
//      as a final fallback for sub-requests.
//
// The HMAC token is signed with STREAM_KEY_SECRET, encodes userId + 5-min
// window — stateless, no DB round-trip per segment.

import { createHmac } from 'crypto'
import { createServerClient } from '@/lib/supabase'
import { authenticateAgent } from '@/lib/agent-auth'

// ── HMAC session token ─────────────────────────────────────────────────────────

const WINDOW_MS = 5 * 60 * 1000
const COOKIE_NAME = 'hls_session'

function makeHlsToken(userId: string): string {
  const secret = process.env.STREAM_KEY_SECRET!
  const w = Math.floor(Date.now() / WINDOW_MS)
  const sig = createHmac('sha256', secret)
    .update(`hls:${userId}:${w}`)
    .digest('hex')
  // Pipe-delimited so split(':') on UUID-containing strings is unambiguous.
  return Buffer.from(`${userId}|${w}|${sig}`).toString('base64url')
}

function verifyHlsToken(token: string): string | null {
  try {
    const secret = process.env.STREAM_KEY_SECRET!
    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    const parts = decoded.split('|')
    if (parts.length !== 3) return null
    const [userId, wStr, sig] = parts
    const tokenW = parseInt(wStr, 10)
    if (isNaN(tokenW)) return null
    const now = Math.floor(Date.now() / WINDOW_MS)
    // Accept current window and previous (handles 5-min boundary crossings).
    for (const w of [now, now - 1]) {
      if (w !== tokenW) continue
      const expected = createHmac('sha256', secret)
        .update(`hls:${userId}:${w}`)
        .digest('hex')
      if (expected === sig) return userId
    }
    return null
  } catch {
    return null
  }
}

// ── Manifest rewriting ─────────────────────────────────────────────────────────

/**
 * Embed ?hlstoken= on all relative URIs in an m3u8 manifest. This is a
 * belt-and-suspenders fallback for environments where cookies aren't sent
 * (cross-origin iframes, certain CDN setups, hls.js fetch loaders). The
 * primary mechanism is the hls_session cookie set on index.m3u8 responses.
 */
function rewriteManifest(text: string, hlsToken: string): string {
  const enc = encodeURIComponent(hlsToken)

  return text.split('\n').map(line => {
    const t = line.trim()
    if (!t) return line

    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        if (uri.startsWith('http')) return match
        const sep = uri.includes('?') ? '&' : '?'
        return `URI="${uri}${sep}hlstoken=${enc}"`
      })
    }

    if (t.startsWith('http')) return line
    const sep = t.includes('?') ? '&' : '?'
    return `${t}${sep}hlstoken=${enc}`
  }).join('\n')
}

// ── Full Supabase/API-key auth (entry point only) ──────────────────────────────

async function authenticateFull(request: Request): Promise<string | null> {
  const agentUserId = await authenticateAgent(request)
  if (agentUserId) return agentUserId

  const url = new URL(request.url)
  const rawToken =
    request.headers.get('authorization')?.replace('Bearer ', '').trim() ??
    url.searchParams.get('token') ??
    ''
  if (!rawToken) return null

  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser(rawToken)
  return user?.id ?? null
}

// ── Route ──────────────────────────────────────────────────────────────────────

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await params
    const segment = path.join('/')
    const url = new URL(request.url)
    const isIndex = segment === 'index.m3u8'
    const isManifest = segment.endsWith('.m3u8')

    // ── Auth (first match wins) ───────────────────────────────────────────────

    let userId: string | null = null

    // 1. Cookie — Safari native <video> sends this automatically for same-origin.
    const cookieHeader = request.headers.get('cookie') ?? ''
    const sessionCookie = cookieHeader
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1)
    if (sessionCookie) {
      userId = verifyHlsToken(sessionCookie)
    }

    // 2. ?hlstoken= URL param — embedded in rewritten manifest URIs.
    if (!userId) {
      const hlsTokenParam = url.searchParams.get('hlstoken')
      if (hlsTokenParam) userId = verifyHlsToken(hlsTokenParam)
    }

    // 3. Full auth (Supabase JWT or API key) — always tried for index.m3u8,
    //    fallback for sub-requests when cookie/token are absent.
    if (!userId) {
      userId = await authenticateFull(request)
    }

    if (!userId) {
      console.warn(`[hls-proxy] 401 ${segment} — no cookie, no hlstoken, no bearer`)
      return new Response('Unauthorized', { status: 401 })
    }

    // ── Instance lookup ───────────────────────────────────────────────────────

    const supabase = createServerClient()
    const { data: instance } = await supabase
      .from('gpu_instances')
      .select('ip_address, hls_port, ingest_key, status')
      .eq('user_id', userId)
      .maybeSingle()

    if (
      !instance ||
      instance.status !== 'running' ||
      !instance.ip_address ||
      !instance.hls_port ||
      !instance.ingest_key
    ) {
      return new Response('Not streaming', { status: 404 })
    }

    // ── Pod fetch ─────────────────────────────────────────────────────────────

    // Forward query params from browser → pod (preserves LLHLS ?_HLS_jwt=).
    // Strip our own auth params — they're Vercel-side only.
    const podParams = new URLSearchParams(url.searchParams)
    podParams.delete('hlstoken')
    podParams.delete('token')
    const podSearch = podParams.toString()
    const podUrl = `http://${instance.ip_address}:${instance.hls_port}/${instance.ingest_key}/${segment}${podSearch ? `?${podSearch}` : ''}`

    console.log(`[hls-proxy] ${segment} uid=${userId.slice(0, 8)} → ${podUrl}`)

    let podRes: Response
    try {
      podRes = await fetch(podUrl, {
        signal: AbortSignal.timeout(10_000),
        headers: { Cookie: 'cookieCheck=1' },
      })
    } catch (err) {
      console.error(`[hls-proxy] pod unreachable (${segment}):`, err)
      return new Response('Pod unreachable', { status: 502 })
    }

    if (!podRes.ok) {
      console.warn(`[hls-proxy] pod ${podRes.status} for ${segment}`)
      return new Response('Not found', { status: podRes.status })
    }

    const contentType = podRes.headers.get('Content-Type') ?? 'application/octet-stream'

    // ── Manifest: set session cookie + rewrite URIs ───────────────────────────

    if (isManifest) {
      const hlsToken = makeHlsToken(userId)
      const text = await podRes.text()
      const rewritten = rewriteManifest(text, hlsToken)

      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store',
      }

      if (isIndex) {
        // Set the session cookie so Safari native <video> sends it on all
        // subsequent sub-playlist and segment requests automatically.
        headers['Set-Cookie'] =
          `${COOKIE_NAME}=${hlsToken}; Path=/api/gpu/hls; HttpOnly; Secure; SameSite=Strict; Max-Age=600`
      }

      return new Response(rewritten, { headers })
    }

    // ── Binary segments ───────────────────────────────────────────────────────

    const body = await podRes.arrayBuffer()
    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store',
      },
    })
  } catch (err) {
    console.error('[hls-proxy] unhandled error:', err)
    return new Response('Internal error', { status: 500 })
  }
}
