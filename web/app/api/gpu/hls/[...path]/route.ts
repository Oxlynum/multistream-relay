// Proxy MediaMTX HLS segments through Vercel so the HTTPS dashboard can load
// the live preview without a mixed-content block (pod serves plain HTTP).
// Auth-gated: only the pod's owner can fetch the stream.

import { createServerClient } from '@/lib/supabase'
import { authenticateAgent } from '@/lib/agent-auth'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const supabase = createServerClient()
  let userId: string | null = null

  userId = await authenticateAgent(request)

  if (!userId) {
    // Accept token in Authorization header or ?token= query param.
    // The <video> src attribute can't carry custom headers, so the query param
    // path is needed for the native Safari HLS player fallback.
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

  let podRes: Response
  try {
    podRes = await fetch(podUrl, { signal: AbortSignal.timeout(10_000) })
  } catch {
    return new Response('Pod unreachable', { status: 502 })
  }

  if (!podRes.ok) {
    return new Response('Not found', { status: podRes.status })
  }

  const contentType = podRes.headers.get('Content-Type') ?? 'application/octet-stream'
  return new Response(podRes.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store',
    },
  })
}
