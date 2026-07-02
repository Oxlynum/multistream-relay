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

// Best-effort client IP for rate-limit keys. Prefer x-real-ip: Vercel (and most proxies) set it
// to the ACTUAL client IP. The LEFT-most x-forwarded-for entry is client-supplied and trivially
// spoofable — keying a limiter on it lets an attacker rotate it to dodge the limit or forge a
// victim's key. Only fall back to XFF (right-most hop, added by our trusted edge) if x-real-ip
// is somehow absent.
export function clientIp(request: Request): string {
  const realIp = request.headers.get('x-real-ip')
  if (realIp?.trim()) return realIp.trim()
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const hops = xff.split(',').map(s => s.trim()).filter(Boolean)
    if (hops.length) return hops[hops.length - 1]
  }
  return 'unknown'
}
