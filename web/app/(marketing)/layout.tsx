import type { ReactNode } from 'react'

import { SiteNav } from '@/components/site-nav'
import { SiteFooter } from '@/components/site-footer'

/**
 * Marketing route-group chrome. SiteNav + SiteFooter mount once here for
 * `/`, `/features`, `/pricing`, `/faq` (they used to be mounted per-page).
 * Pages in this group return their sections directly — no <main>, no chrome.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteNav />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  )
}
