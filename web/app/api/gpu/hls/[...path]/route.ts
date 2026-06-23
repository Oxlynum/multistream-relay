// Proxy MediaMTX HLS segments through Vercel so the HTTPS dashboard can load
// the live preview without a mixed-content block (pod serves plain HTTP).
// Auth-gated: only the pod's owner can fetch the stream.
//
// Auth: hls.js sends every request (manifest + sub-manifests + segments) with
// an Authorization header set via xhrSetup/fetchSetup. The ?token= query-param
// path is kept as a fallback for the native Safari <video> src AND for
// sub-playlist/segment URLs rewritten into the manifest body.

import { createServerClient } from '@/lib/supabase'
import { authenticateAgent } from '@/lib/agent-auth'

/** Extract the raw bearer token from Authorization header or ?token= param. */
function extractRawToken(request: Request): string {
  const auth = request.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  return new URL(request.url).searchParams.get('token') ?? ''
}

/**
 * Rewrite relative URIs in an m3u8 manifest to embed ?token= so that native
 * Safari <video> (which doesn't send Authorization headers on sub-resource
 * requests) can authenticate follow-up manifest/segment fetches through the
 * Vercel proxy. Also handles URI="..." attributes (#EXT-X-MEDIA audio tracks).
 *
 * LLHLS already embeds ?_HLS_jwt= in sub-playlist URLs — this appends &token=
 * to those, so both the pod JWT and the Vercel auth token travel together.
 */
function rewriteManifest(text: string, token: string): string {
  if (!token) return text
  const enc = encodeURIComponent(token)

  return text.split('\n').map(line => {
    const t = line.trim()
    if (!t) return line

    // Tag lines: rewrite URI="..." attributes (e.g. #EXT-X-MEDIA audio tracks)
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        if (uri.startsWith('http')) return match
        const sep = uri.includes('?') ? '&' : '?'
        return `URI="${uri}${sep}token=${enc}"`
      })
    }

    // Plain URI lines (sub-playlists, segments) — skip absolute URLs
    if (t.startsWith('http')) return line
    const sep = t.includes('?') ? '&' : '?'
    return `${t}${sep}token=${enc}`
  }).join('\n')
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const supabase = createServerClient()
    let userId: string | null = null

    userId = await authenticateAgent(request)

    if (!userId) {
      const url = new URL(request.url)
      const token =
        request.headers.get('authorization')?.replace('Bearer ', '') ??
        url.searchParams.get('token') ??
        ''
      if (token) {
        const { data: { user } } = await supabase.auth.getUser(token)
        userId = user?.id ?? null
      }
    }

    if (!userId) {
      return new Response('Unauthorized', { status: 401 })
    }

    const { data: instance } = await supabase
      .from('gpu_instances')
      .select('ip_address, hls_port, ingest_key, status')
      .eq('user_id', userId)
      .maybeSingle()

    if (!instance || instance.status !== 'running' || !instance.ip_address || !instance.hls_port || !instance.ingest_key) {
      return new Response('Not streaming', { status: 404 })
    }

    const { path } = await params
    const segment = path.join('/')

    // Forward query params from the browser to the pod — LLHLS embeds
    // ?_HLS_jwt=<token> in sub-playlist URLs; stripping them causes pod 401s.
    // Exclude our own ?token= (Vercel-side auth only, not for MediaMTX).
    const incomingUrl = new URL(request.url)
    const podParams = new URLSearchParams(incomingUrl.searchParams)
    podParams.delete('token')
    const podSearch = podParams.toString()
    const podUrl = `http://${instance.ip_address}:${instance.hls_port}/${instance.ingest_key}/${segment}${podSearch ? `?${podSearch}` : ''}`

    console.log(`[hls-proxy] → ${podUrl}`)

    let podRes: Response
    try {
      // Send the LLHLS session cookie preemptively so MediaMTX skips its
      // cookieCheck redirect and serves content directly.
      podRes = await fetch(podUrl, {
        signal: AbortSignal.timeout(10_000),
        headers: { Cookie: 'cookieCheck=1' },
      })
    } catch (err) {
      console.error('[hls-proxy] pod fetch failed:', err)
      return new Response('Pod unreachable', { status: 502 })
    }

    if (!podRes.ok) {
      console.log(`[hls-proxy] pod returned ${podRes.status} for ${segment}`)
      return new Response('Not found', { status: podRes.status })
    }

    const contentType = podRes.headers.get('Content-Type') ?? 'application/octet-stream'
    const isManifest = segment.endsWith('.m3u8') || contentType.includes('mpegurl')

    if (isManifest) {
      // Rewrite sub-playlist and segment URIs to embed the browser auth token
      // so native Safari <video> can authenticate follow-up requests.
      const rawToken = extractRawToken(request)
      const text = await podRes.text()
      const rewritten = rewriteManifest(text, rawToken)
      return new Response(rewritten, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache, no-store',
        },
      })
    }

    // Buffer the body to avoid ReadableStream consumption issues across the proxy boundary.
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
