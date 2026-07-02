'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Menu } from 'lucide-react'
import { Logo } from './logo'
import { ScanlineToggle } from './scanline-toggle'
import { createBrowserClient } from '@/lib/supabase'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

const LINKS = [
  { href: '/#how', label: 'How it works' },
  { href: '/features', label: 'Features' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/faq', label: 'FAQ' },
]

export function SiteNav() {
  const [open, setOpen] = useState(false)
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createBrowserClient()

    supabase.auth.getSession().then(({ data: { session } }: { data: { session: unknown } }) => {
      setIsLoggedIn(!!session)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event: unknown, session: unknown) => setIsLoggedIn(!!session),
    )

    return () => subscription.unsubscribe()
  }, [])

  return (
    <header className="sticky top-0 z-50 border-b border-line/70 bg-bg/80 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Logo />

        <div className="hidden items-center gap-8 text-sm md:flex">
          {LINKS.map(l => (
            <a
              key={l.href}
              href={l.href}
              className="text-ink-muted transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="hidden min-w-[200px] items-center justify-end gap-2 md:flex">
          <ScanlineToggle />
          {loading ? null : isLoggedIn ? (
            <Link href="/dashboard" className={buttonVariants({ variant: 'secondary' })}>
              Dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className={buttonVariants({ variant: 'ghost' })}>
                Log in
              </Link>
              <Link href="/signup" className={cn(buttonVariants(), 'shadow-glow')}>
                ▶ Press Start
              </Link>
            </>
          )}
        </div>

        {/* Mobile */}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            render={
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" />
            }
          >
            <Menu className="h-5 w-5" />
          </SheetTrigger>
          <SheetContent side="right" className="w-72 border-line bg-bg">
            <SheetHeader>
              <SheetTitle className="text-left">
                <Logo href={null} />
              </SheetTitle>
            </SheetHeader>
            <div className="mt-2 flex flex-col gap-1 px-4">
              {LINKS.map(l => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-2.5 text-sm text-ink-muted transition-colors hover:bg-surface hover:text-ink"
                >
                  {l.label}
                </a>
              ))}
            </div>
            <div className="mt-4 flex flex-col gap-2 px-4">
              <div className="pb-2">
                <ScanlineToggle />
              </div>
              {loading ? null : isLoggedIn ? (
                <Link
                  href="/dashboard"
                  onClick={() => setOpen(false)}
                  className={cn(buttonVariants(), 'w-full')}
                >
                  Go to Dashboard
                </Link>
              ) : (
                <>
                  <Link
                    href="/login"
                    onClick={() => setOpen(false)}
                    className={cn(buttonVariants({ variant: 'secondary' }), 'w-full')}
                  >
                    Log in
                  </Link>
                  <Link
                    href="/signup"
                    onClick={() => setOpen(false)}
                    className={cn(buttonVariants(), 'w-full shadow-glow')}
                  >
                    ▶ Press Start
                  </Link>
                </>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </nav>
    </header>
  )
}
