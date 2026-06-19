'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Logo } from './logo'

const TABS = [
  { href: '/dashboard', label: 'Overview' },
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
    <header className="border-b border-line bg-base/80 backdrop-blur-xl sticky top-0 z-40">
      <div className="max-w-5xl mx-auto px-6">
        <div className="flex items-center justify-between h-16">
          <Logo href="/" />
          <button
            onClick={signOut}
            className="text-sm text-ink-muted hover:text-ink transition-colors"
          >
            Sign out
          </button>
        </div>
        <nav className="flex gap-1 -mb-px">
          {TABS.map(t => {
            const active = pathname === t.href
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`px-4 py-3 text-sm border-b-2 transition-colors ${
                  active
                    ? 'border-accent text-ink font-medium'
                    : 'border-transparent text-ink-muted hover:text-ink'
                }`}
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
