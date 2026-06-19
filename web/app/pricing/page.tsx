import Link from 'next/link'
import type { Metadata } from 'next'
import { SiteNav } from '@/components/site-nav'
import { SiteFooter } from '@/components/site-footer'

export const metadata: Metadata = {
  title: 'Pricing — SlimCast',
  description: 'Pay-per-second streaming at $2/hour. No subscription. 2 free hours on signup.',
}

const INCLUDED = [
  'All five platforms simultaneously',
  '1080p60 maximum quality',
  'HEVC uplink — push less data',
  'Hardware GPU transcoding',
  'Per-platform bitrate, FPS & orientation',
  'Automatic reconnect & failover',
  'Auto-launch from OBS — no idle billing',
  'Optional auto-refill',
  'Credits never expire',
]

const EXAMPLES = [
  { hrs: '2 hrs / week', cost: '~$16 / mo', note: 'Casual streamer' },
  { hrs: '10 hrs / week', cost: '~$80 / mo', note: 'Regular schedule' },
  { hrs: '25 hrs / week', cost: '~$200 / mo', note: 'Full-time creator' },
]

const FAQ = [
  {
    q: 'How is the $2/hour billed?',
    a: 'By the second. A 37-minute stream costs about $1.23. You buy credits up front and they’re drawn down only while you’re live.',
  },
  {
    q: 'Do credits expire?',
    a: 'Never. Buy a block of hours and use them whenever — there’s no monthly reset and no “use it or lose it.”',
  },
  {
    q: 'Is there really no subscription?',
    a: 'Correct. There’s nothing recurring to cancel. You only ever pay for streaming time you actually use.',
  },
  {
    q: 'What’s included in the 2 free hours?',
    a: 'Everything. All five platforms, full 1080p60, every feature is included in the 2 free hours.',
  },
]

export default function PricingPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteNav />

      <main className="flex-1">
        <section className="relative overflow-hidden border-b border-line">
          <div className="absolute inset-0 bg-grid mask-fade pointer-events-none" />
          <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[600px] h-[500px] bg-accent/10 rounded-full blur-[120px] pointer-events-none" />
          <div className="relative max-w-3xl mx-auto px-6 pt-20 pb-12 text-center">
            <div className="kicker mb-4">Pricing</div>
            <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-5">
              Pay only for what you stream
            </h1>
            <p className="text-lg text-ink-muted max-w-xl mx-auto">
              One simple rate, billed by the second. No tiers, no subscription, no surprises.
            </p>
          </div>
        </section>

        {/* Price card */}
        <section className="max-w-3xl mx-auto px-6 -mt-2 py-12">
          <div className="rounded-2xl border border-accent/40 bg-surface p-8 glow-accent">
            <div className="grid md:grid-cols-2 gap-8 items-center">
              <div>
                <div className="flex items-end gap-2 mb-1">
                  <div className="text-6xl font-extrabold tracking-tight">$2</div>
                  <div className="text-ink-muted text-lg mb-2">/ hour</div>
                </div>
                <div className="text-sm text-ink-faint mb-6 font-mono">billed per second · credits never expire</div>
                <div className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent-soft/40 px-3 py-1 text-xs text-accent mb-6">
                  2 free hours on signup
                </div>
                <Link
                  href="/signup"
                  className="block text-center bg-accent hover:bg-accent-strong text-base font-semibold py-3 rounded-lg transition-colors"
                >
                  Get started free
                </Link>
                <p className="text-xs text-ink-faint text-center mt-3">No credit card required</p>
              </div>

              <ul className="space-y-2.5">
                {INCLUDED.map(item => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-ink-muted">
                    <svg viewBox="0 0 20 20" className="w-4 h-4 text-accent shrink-0 mt-0.5" fill="currentColor">
                      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 10a1 1 0 1 1 1.4-1.4l3.3 3.3 6.8-6.8a1 1 0 0 1 1.4 0z" clipRule="evenodd" />
                    </svg>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Cost examples */}
        <section className="max-w-4xl mx-auto px-6 py-12">
          <div className="text-center mb-8">
            <div className="kicker mb-3">What it costs in practice</div>
            <h2 className="text-2xl font-bold tracking-tight">No matter how you stream, you pay for time used</h2>
          </div>
          <div className="grid sm:grid-cols-3 gap-4">
            {EXAMPLES.map(e => (
              <div key={e.hrs} className="rounded-xl border border-line bg-surface p-6 text-center">
                <div className="text-sm text-ink-muted mb-2">{e.hrs}</div>
                <div className="text-3xl font-bold font-mono mb-1">{e.cost}</div>
                <div className="text-xs text-ink-faint">{e.note}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-ink-faint text-center mt-4">
            Estimates at $2/hour. You’re only charged for seconds you’re actually live.
          </p>
        </section>

        {/* FAQ */}
        <section className="border-t border-line bg-surface/40">
          <div className="max-w-3xl mx-auto px-6 py-16">
            <h2 className="text-2xl font-bold tracking-tight text-center mb-8">Billing questions</h2>
            <div className="space-y-3">
              {FAQ.map(item => (
                <details key={item.q} className="group rounded-xl border border-line bg-base px-5 open:border-line-strong">
                  <summary className="flex items-center justify-between cursor-pointer py-4 text-sm font-medium text-ink list-none">
                    {item.q}
                    <span className="text-ink-faint group-open:rotate-45 transition-transform text-lg leading-none">+</span>
                  </summary>
                  <p className="text-sm text-ink-muted leading-relaxed pb-5 -mt-1">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
