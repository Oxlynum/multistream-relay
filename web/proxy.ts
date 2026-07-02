import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'

// "Under construction" splash. Gated on SLIMCAST_UNDER_CONSTRUCTION=true.
// Hides the public front end without touching any front-end component code —
// the request is short-circuited here, before any page renders. `/api/*` is
// excluded by the matcher, so pods/OBS/agent/Stripe webhooks keep working.
// Bypass for the owner: visit any URL with `?preview=<SLIMCAST_PREVIEW_SECRET>`
// once; it sets an httpOnly cookie and the real site renders thereafter.
const CONSTRUCTION_COOKIE = 'slimcast_preview'

const CONSTRUCTION_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>SlimCast — Under construction</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(1200px 600px at 50% -10%, #1b2740 0%, #0b0f17 60%);
    color: #e7ecf5;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    text-align: center; padding: 24px;
  }
  .card { max-width: 560px; }
  .badge {
    font-size: 13px; letter-spacing: .14em; text-transform: uppercase;
    color: #7f9bd1; margin-bottom: 18px;
  }
  h1 { font-size: clamp(28px, 6vw, 44px); margin: 0 0 12px; font-weight: 700; }
  p { margin: 0 auto; max-width: 420px; color: #aab6cc; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#ffb23e; margin-right:8px; vertical-align: middle; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:.35} 50%{opacity:1} }
</style>
</head>
<body>
  <main class="card">
    <div class="badge"><span class="dot"></span>SlimCast</div>
    <h1>Under construction</h1>
    <p>We're putting the finishing touches on something good. Check back soon.</p>
  </main>
</body>
</html>`

function handleConstruction(request: NextRequest): NextResponse | null {
  if (process.env.SLIMCAST_UNDER_CONSTRUCTION !== 'true') return null

  const secret = process.env.SLIMCAST_PREVIEW_SECRET
  const url = request.nextUrl

  // One-time bypass grant: ?preview=<secret> sets a cookie, then redirects clean.
  if (secret && url.searchParams.get('preview') === secret) {
    const clean = new URL(url)
    clean.searchParams.delete('preview')
    const res = NextResponse.redirect(clean)
    res.cookies.set(CONSTRUCTION_COOKIE, secret, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    })
    return res
  }

  // Already bypassed → render the real site.
  if (secret && request.cookies.get(CONSTRUCTION_COOKIE)?.value === secret) return null

  // Public visitor → splash.
  return new NextResponse(CONSTRUCTION_HTML, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '3600',
    },
  })
}

// Renamed from `middleware` to `proxy` per Next.js 16 (the middleware file
// convention is deprecated). Runtime is nodejs — fine for Supabase SSR here.
export async function proxy(request: NextRequest) {
  const construction = handleConstruction(request)
  if (construction) return construction

  const { pathname } = request.nextUrl

  // Protect all dashboard and onboarding routes. Match on a path boundary so
  // public assets that merely share the prefix (e.g. /dashboard-preview.png) are
  // NOT redirected to /login — that boundary bug had been breaking the hero image.
  const isProtected =
    pathname === '/dashboard' ||
    pathname.startsWith('/dashboard/') ||
    pathname === '/onboarding' ||
    pathname.startsWith('/onboarding/')
  if (isProtected) {
    let response = NextResponse.next({ request })

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            )
            response = NextResponse.next({ request })
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('next', pathname)
      return NextResponse.redirect(loginUrl)
    }

    return response
  }

  return NextResponse.next()
}

export const config = {
  // Run on every page request so the under-construction gate can cover the whole
  // site, but exclude `/api` (backend must keep serving pods/OBS/Stripe) and
  // Next's static assets. The dashboard/onboarding auth logic above is still
  // scoped by its own pathname checks.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
