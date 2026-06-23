// Proxy MediaMTX HLS segments through Vercel so the HTTPS dashboard can load
// the live preview without a mixed-content block (pod serves plain HTTP).
// Auth-gated: only the pod's owner can fetch the stream.
//
// Two-tier auth:
//   1. index.m3u8  → full auth (Supabase JWT or API key). On success we issue
//      a short-lived HMAC session token and embed it in all rewritten URLs.
//   2. Sub-playlists / segments → accept the HMAC session token directly (fast,
//      no Supabase round-trip per segment). Also accept full auth as a fallback.
//
// The HMAC token is valid for two 5-minute windows (boundary-safe), signed with
// STREAM_KEY_SECRET, and encodes the userId so no DB lookup is needed.

import { createHmac } from 'crypto'
import { createServerClient } from '@/lib/supabase'
import { authenticateAgent } from '@/lib/agent-auth'

// ── HLS session tokens ─────────────────────────────────────────────────────────

const WINDOW_MS = 5 * 60 * 1000

function makeHlsToken(userId: string): string {
  const secret = process.env.STREAM_KEY_SECRET!
  const w = Math.floor(Date.now() / WINDOW_MS)
  const sig = createHmac('sha256', secret).update(`hls:${userId}:${w}`).digest('hex')
  return Buffer.from(`${userId}:${w}:${sig}`).toString('base64url')
}

function verifyHlsToken(token: string): string | null {
  try {
    const secret = process.env.STREAM_KEY_SECRET!
    const decoded = Buffer.from(token, 'base64url').toString('utf8')
    const [userId, wStr, sig] = decoded.split(':')
    if (!userId || !wStr || !sig) return null
    const tokenW = parseInt(wStr, 10)
    const now = Math.floor(Date.now() / WINDOW_MS)
    for (const w of [now, now - 1]) {
      if (w !== tokenW) continue
      const expected = createHmac('sha256', secret).update(`hls:${userId}:${w}`).digest('hex')
      if (expected === sig) return userId
    }
    return null
  } catch {
    return null
  }
}

// ── Manifest rewriting ─────────────────────────────────────────────────────────

/**
 * Rewrite relative URIs in an m3u8 manifest to embed an ?hlstoken= so that
 * Safari native <video> and any loader that doesn't send Authorization headers
 * can authenticate follow-up requests without a Supabase round-trip.
 *
 * LLHLS manifests may already have ?_HLS_jwt= on sub-playlist URLs — we append
 * &hlstoken= to those so both the pod JWT and our token travel together.
 */
function rewriteManifest(text: string, hlsToken: string): string {
  const enc = encodeURIComponent(hlsToken)

  return text.split('\n').map(line => {
    const t = line.trim()
    if (!t) return line

    // Tag lines: rewrite URI="..." attributes (e.g. #EXT-X-MEDIA audio tracks)
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        if (uri.startsWith('http')) return match
        const sep = uri.includes('?') ? '&' : '?'
        return `URI="${uri}${sep}hlstoken=${enc}"`
      })
    }

    // Plain URI lines (sub-playlists, segments) — skip absolute URLs
    if (t.startsWith('http')) return line
    const sep = t.includes('?') ? '&' : '?'
    return `${t}${sep}hlstoken=${enc}`
  }).join('\n')
}

// ── Full auth (used for index.m3u8 and as fallback) ───────────────────────────

async function authenticateFull(request: Request): Promise<string | null> {
  // 1. API key (OBS plugin / pod)
  const agentUserId = await authenticateAgent(request)
  if (agentUserId) return agentUserId

  // 2. Supabase JWT in Authorization header or ?token= param
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
    const isManifest = segment.endsWith('.m3u8')
    const isIndex = segment === 'index.m3u8'

    // ── Auth ──────────────────────────────────────────────────────────────────
    let userId: string | null = null

    // Fast path: HMAC session token (sub-playlists + segments after manifest served)
    const hlsTokenParam = url.searchParams.get('hlstoken')
    if (hlsTokenParam) {
      userId = verifyHlsToken(hlsTokenParam)
    }

    // Full auth fallback (always required for index, fallback for others)
    if (!userId) {
      userId = await authenticateFull(request)
    }

    if (!userId) {
      console.warn(`[hls-proxy] 401 for ${segment} — no valid auth`)
      return new Response('Unauthorized', { status: 401 })
    }

    // ── Instance lookup ───────────────────────────────────────────────────────
    const supabase = createServerClient()
    const { data: instance } = await supabase
      .from('gpu_instances')
      .select('ip_address, hls_port, ingest_key, status')
      .eq('user_id', userId)
      .maybeSingle()

    if (!instance || instance.status !== 'running' || !instance.ip_address || !instance.hls_port || !instance.ingest_key) {
      return new Response('Not streaming', { status: 404 })
    }

    // ── Pod fetch ─────────────────────────────────────────────────────────────
    // Forward query params from browser → pod (LLHLS embeds ?_HLS_jwt=).
    // Exclude our own auth params — they're Vercel-side only, not for MediaMTX.
    const podParams = new URLSearchParams(url.searchParams)
    podParams.delete('hlstoken')
    podParams.delete('token')
    const podSearch = podParams.toString()
    const podUrl = `http://${instance.ip_address}:${instance.hls_port}/${instance.ingest_key}/${segment}${podSearch ? `?${podSearch}` : ''}`

    console.log(`[hls-proxy] ${segment} → ${podUrl}`)

    let podRes: Response
    try {
      // Send cookieCheck=1 to bypass MediaMTX's LLHLS cookie redirect.
      podRes = await fetch(podUrl, {
        signal: AbortSignal.timeout(10_000),
        headers: { Cookie: 'cookieCheck=1' },
      })
    } catch (err) {
      console.error(`[hls-proxy] pod unreachable for ${segment}:`, err)
      return new Response('Pod unreachable', { status: 502 })
    }

    if (!podRes.ok) {
      console.warn(`[hls-proxy] pod returned ${podRes.status} for ${segment}`)
      return new Response('Not found', { status: podRes.status })
    }

    const contentType = podRes.headers.get('Content-Type') ?? 'application/octet-stream'

    if (isManifest) {
      // Issue a fresh HLS session token and embed it in all sub-playlist/segment
      // URIs so follow-up requests authenticate without a Supabase round-trip.
      const hlsToken = isIndex ? makeHlsToken(userId) : (hlsTokenParam ?? makeHlsToken(userId))
      const text = await podRes.text()
      const rewritten = rewriteManifest(text, hlsToken)
      return new Response(rewritten, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache, no-store',
        },
      })
    }

    // Binary segments — buffer to avoid ReadableStream consumption issues.
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
