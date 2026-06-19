import { SiteNav } from '@/components/site-nav'
import { SiteFooter } from '@/components/site-footer'

const FAQ = [
  {
    q: 'What are the local hardware requirements?',
    a: 'SlimCast offloads all multiplexing and transcode workloads to dedicated cloud infrastructure. Local hardware requirements are identical to single-destination streaming configurations.',
  },
  {
    q: 'What are the upstream bandwidth requirements?',
    a: 'A single uplink connection of 8–10 Mbps is sufficient to push a high-quality HEVC source feed. Our edge nodes manage the bandwidth requirements for parallel distribution to all downstream platforms.',
  },
  {
    q: 'How is credential security managed?',
    a: 'Stream keys utilize at-rest encryption and are injected into memory solely during active streaming sessions. Keys are never exposed to the client or baked into persistent container images.',
  },
  {
    q: 'How does the billing model operate?',
    a: 'Metered billing operates on a per-second basis while instances are active, billed at $2.00 per hour. There are no idle costs or recurring subscriptions. Account verification provides 2 free hours of instance runtime.',
  },
  {
    q: 'What is the behavior upon resource depletion?',
    a: 'Real-time telemetry via the OBS plugin provides capacity alerts at the 30-minute threshold. Sessions terminate gracefully upon credit depletion unless automated replenishment is configured.',
  },
  {
    q: 'Which downstream endpoints are supported?',
    a: 'SlimCast supports RTMP distribution to Twitch, YouTube, Kick, and TikTok. Streams are automatically formatted per platform specifications, including vertical orientation for TikTok and up to 1080p60 for landscape endpoints.',
  },
]

export default function FAQPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteNav />

      <main className="flex-1">
        <section className="max-w-3xl mx-auto px-6 py-24">
          <div className="mb-12">
            <div className="kicker mb-3">Resources</div>
            <h1 className="text-4xl font-bold tracking-tight">Frequently Asked Questions</h1>
          </div>

          <div className="space-y-4">
            {FAQ.map(item => (
              <details key={item.q} className="group rounded-xl border border-line bg-surface/40 p-6 open:bg-surface open:border-line-strong transition-colors">
                <summary className="flex items-center justify-between cursor-pointer text-base font-semibold text-ink list-none">
                  {item.q}
                  <span className="text-ink-faint group-open:rotate-45 transition-transform text-xl leading-none font-light">+</span>
                </summary>
                <p className="text-sm text-ink-muted leading-relaxed mt-4">{item.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
