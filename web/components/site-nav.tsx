'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Logo } from './logo'

const LINKS = [
  { href: '/#how', label: 'How it works' },
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/#compare', label: 'Compare' },
  { href: '/#faq', label: 'FAQ' },
]

export function SiteNav() {
  const [open, setOpen] = useState(false)

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

        <div className="hidden md:flex items-center gap-3 text-sm">
          <Link href="/login" className="text-ink-muted hover:text-ink transition-colors px-3 py-1.5">
            Log in
          </Link>
          <Link
            href="/signup"
            className="bg-accent hover:bg-accent-strong text-base font-semibold px-4 py-1.5 rounded-md transition-colors"
          >
            Get started
          </Link>
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
            <Link href="/login" className="flex-1 text-center border border-line-strong rounded-md py-2 text-sm">
              Log in
            </Link>
            <Link href="/signup" className="flex-1 text-center bg-accent text-base font-semibold rounded-md py-2 text-sm">
              Get started
            </Link>
          </div>
        </div>
      )}
    </header>
  )
}
