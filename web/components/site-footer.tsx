import Link from 'next/link'
import { Logo } from './logo'
import { LiveDot } from '@/components/ui/live-dot'

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '/features', label: 'Features' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/#how', label: 'How it works' },
    ],
  },
  {
    title: 'Account',
    links: [
      { href: '/signup', label: 'Get started' },
      { href: '/login', label: 'Log in' },
      { href: '/dashboard', label: 'Dashboard' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { href: '/faq', label: 'FAQ' },
      { href: '/#trust', label: 'How it’s built' },
    ],
  },
]

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-bg">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid grid-cols-2 gap-10 md:grid-cols-5">
          <div className="col-span-2">
            <Logo href={null} />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-muted">
              One stream up, every platform live. Multistream infrastructure built
              for creators on Twitch, YouTube, Kick, and TikTok.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 text-xs text-ink-faint">
              <LiveDot color="success" size={8} />
              All systems operational
            </div>
          </div>

          {COLUMNS.map(col => (
            <div key={col.title}>
              <div className="mb-4 font-mono text-xs font-semibold uppercase tracking-[0.16em] text-ink-faint">
                {col.title}
              </div>
              <ul className="space-y-2.5">
                {col.links.map(l => (
                  <li key={l.href + l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-ink-muted transition-colors hover:text-ink"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-line pt-6 text-xs text-ink-faint sm:flex-row">
          <span>© {new Date().getFullYear()} SlimCast. All rights reserved.</span>
          <span className="font-mono">Free during early access · no second PC, no terminal</span>
        </div>
      </div>
    </footer>
  )
}
