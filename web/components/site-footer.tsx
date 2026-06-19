import Link from 'next/link'
import { Logo } from './logo'

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
    <footer className="border-t border-line bg-base">
      <div className="max-w-6xl mx-auto px-6 py-14">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-10">
          <div className="col-span-2">
            <Logo href={null} />
            <p className="text-sm text-ink-muted mt-4 max-w-xs leading-relaxed">
              One stream in, every platform live. Multistream infrastructure built for
              creators on Twitch, YouTube, and beyond.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 text-xs text-ink-faint">
              <span className="relative inline-flex w-2 h-2 text-accent">
                <span className="pulse-dot" />
                <span className="relative w-2 h-2 rounded-full bg-accent" />
              </span>
              All systems operational
            </div>
          </div>

          {COLUMNS.map(col => (
            <div key={col.title}>
              <div className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-4">
                {col.title}
              </div>
              <ul className="space-y-2.5">
                {col.links.map(l => (
                  <li key={l.href + l.label}>
                    <Link href={l.href} className="text-sm text-ink-muted hover:text-ink transition-colors">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 pt-6 border-t border-line flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-ink-faint">
          <span>© {new Date().getFullYear()} SlimCast. All rights reserved.</span>
          <span className="font-mono">Pay-per-second · $2/hr · no subscription</span>
        </div>
      </div>
    </footer>
  )
}
