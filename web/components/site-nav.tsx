'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Logo } from './logo'
import { createBrowserClient } from '@/lib/supabase'

const LINKS = [
  { href: '/#how', label: 'How it works' },
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/#compare', label: 'Compare' },
  { href: '/#faq', label: 'FAQ' },
]

export function SiteNav() {
  const [open, setOpen] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createBrowserClient()
    
    supabase.auth.getSession().then(({ data: { session } }) => {
      setIsLoggedIn(!!session)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsLoggedIn(!!session)
    })

    return () => subscription.unsubscribe()
  }, [])

  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-base/80 backdrop-blur-xl">
      <nav className="max-w-6xl mx-auto flex items-center justify-between px-6 h-16">
        <Logo />

        <div className="hidden md:flex items-center gap-8 text-sm">
          {LINKS.map(l => (
            <a key={l.href} href={l.href} className="text-ink-muted hover:text-ink transition-colors">
              {l.label}
            </a>
          ))}
        </div>

        <div className="hidden md:flex items-center gap-3 text-sm min-w-[180px] justify-end">
          {loading ? null : isLoggedIn ? (
            <Link
              href="/dashboard"
              className="bg-surface border border-line-strong hover:border-accent hover:text-accent text-ink px-5 py-2 rounded-lg font-medium transition-all"
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="text-ink-muted hover:text-ink transition-colors px-3 py-1.5 font-medium">
                Log in
              </Link>
              <Link
                href="/signup"
                className="bg-accent hover:bg-accent-strong text-base font-semibold px-5 py-2 rounded-lg transition-all glow-accent"
              >
                Get started
              </Link>
            </>
          )}
        </div>

        <button
          onClick={() => setOpen(o => !o)}
          className="md:hidden text-ink-muted hover:text-ink p-2 -mr-2"
          aria-label="Toggle menu"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {open ? <path d="M6 6l12 12M6 18L18 6" strokeLinecap="round" /> : <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />}
          </svg>
        </button>
      </nav>

      {open && (
        <div className="md:hidden border-t border-line bg-base px-6 py-4 space-y-3">
          {LINKS.map(l => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="block text-ink-muted hover:text-ink transition-colors py-1"
            >
              {l.label}
            </a>
          ))}
          <div className="flex gap-3 pt-2">
            {loading ? null : isLoggedIn ? (
              <Link href="/dashboard" className="flex-1 text-center border border-line-strong hover:bg-surface hover:text-accent rounded-lg py-2.5 text-sm font-medium transition-colors">
                Go to Dashboard
              </Link>
            ) : (
              <>
                <Link href="/login" className="flex-1 text-center border border-line-strong hover:bg-surface rounded-lg py-2.5 text-sm font-medium transition-colors">
                  Log in
                </Link>
                <Link href="/signup" className="flex-1 text-center bg-accent text-base font-semibold rounded-lg py-2.5 text-sm glow-accent transition-all">
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  )
}
