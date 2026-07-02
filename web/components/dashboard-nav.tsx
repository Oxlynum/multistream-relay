'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Logo } from './logo'
import { ScanlineToggle } from './scanline-toggle'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const TABS = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/stream', label: 'Stream' },
  { href: '/dashboard/platforms', label: 'Platforms' },
  { href: '/dashboard/settings', label: 'Settings' },
  { href: '/dashboard/credits', label: 'Credits' },
]

export function DashboardNav() {
  const pathname = usePathname()
  const router = useRouter()

  async function signOut() {
    const supabase = createBrowserClient()
    await supabase.auth.signOut()
    router.push('/')
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto max-w-5xl px-6">
        <div className="flex h-16 items-center justify-between">
          <Logo href="/" />
          <div className="flex items-center gap-3">
            <ScanlineToggle />
            <Button variant="ghost" size="sm" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
        <nav className="-mb-px flex gap-1 overflow-x-auto">
          {TABS.map(t => {
            const active = pathname === t.href
            return (
              <Link
                key={t.href}
                href={t.href}
                className={cn(
                  'whitespace-nowrap border-b-2 px-4 py-3 text-sm transition-colors',
                  active
                    ? 'border-brand font-medium text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {t.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
