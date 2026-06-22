import { createServerClient } from '@/lib/supabase'

// Supabase-backed fixed-window rate limiter. Cross-instance correct (Vercel
// serverless gives no shared memory), no extra vendor. Fails OPEN: if the
// limiter store itself errors we allow the request rather than hard-blocking
// legitimate traffic on an infra hiccup.
export async function checkRateLimit(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const supabase = createServerClient()
    const { data, error } = await supabase.rpc('rate_limit_hit', {
      p_key: key,
      p_max: max,
      p_window_secs: windowSeconds,
    })
    if (error) return true
    return data === true
  } catch {
    return true
  }
}

// Best-effort client IP from the standard proxy headers (Vercel sets these).
export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}
