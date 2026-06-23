// Proxy MediaMTX HLS segments through Vercel so the HTTPS dashboard can load
// the live preview without a mixed-content block (pod serves plain HTTP).
// Auth-gated: only the pod's owner can fetch the stream.
//
// Auth: hls.js sends every request (manifest + sub-manifests + segments) with
// an Authorization header set via xhrSetup. The ?token= query-param path is kept
// as a fallback for the native Safari <video> src.

import { createServerClient } from '@/lib/supabase'
import { authenticateAgent } from '@/lib/agent-auth'

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
    const podUrl = `http://${instance.ip_address}:${instance.hls_port}/${instance.ingest_key}/${segment}`

    console.log(`[hls-proxy] → ${podUrl}`)

    let podRes: Response
    try {
      podRes = await fetch(podUrl, { signal: AbortSignal.timeout(10_000) })
    } catch (err) {
      console.error('[hls-proxy] pod fetch failed:', err)
      return new Response('Pod unreachable', { status: 502 })
    }

    if (!podRes.ok) {
      console.log(`[hls-proxy] pod returned ${podRes.status} for ${segment}`)
      return new Response('Not found', { status: podRes.status })
    }

    const contentType = podRes.headers.get('Content-Type') ?? 'application/octet-stream'
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
