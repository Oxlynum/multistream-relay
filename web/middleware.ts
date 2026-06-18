import { type NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // /obs-dock handles its own auth via ?key= query param — let it through.
  if (pathname.startsWith('/obs-dock')) {
    return NextResponse.next()
  }

  // Protect all dashboard routes.
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/onboarding')) {
    const token = request.cookies.get('sb-access-token')?.value
      ?? request.cookies.get('supabase-auth-token')?.value

    if (!token) {
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('next', pathname)
      return NextResponse.redirect(loginUrl)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*', '/onboarding/:path*', '/obs-dock/:path*'],
}
