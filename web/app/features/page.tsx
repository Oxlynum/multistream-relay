import Link from 'next/link'
import type { Metadata } from 'next'
import { SiteNav } from '@/components/site-nav'
import { SiteFooter } from '@/components/site-footer'

export const metadata: Metadata = {
  title: 'Features — SlimCast',
  description:
    'HEVC uplink, hardware GPU transcoding, five platforms at once, per-platform tuning, and pay-per-second billing.',
}

const SECTIONS = [
  {
    kicker: 'Uplink',
    title: 'Push less, stream more',
    body: 'Most multistream tools make you send a separate H.264 stream for every platform — five destinations means five times the upload. SlimCast takes a single HEVC feed instead. You send roughly 40% less data than even one H.264 stream, and we expand it to five in the cloud.',
    points: [
      'Single HEVC (H.265) feed out of OBS',
      'Apple VT / NVENC hardware encoding supported',
      'Designed for creators with limited upload bandwidth',
      'No second PC or capture box required',
    ],
  },
  {
    kicker: 'Transcode',
    title: 'A broadcast GPU, on demand',
    body: 'When you hit Start in OBS, SlimCast provisions a dedicated cloud GPU with hardware NVENC. It decodes your HEVC feed once and re-encodes an H.264 output tuned to each platform’s limits — all in parallel, all on silicon built for this.',
    points: [
      'Hardware NVDEC decode + NVENC encode',
      'Quality-tuned: CBR, lookahead, spatial/temporal AQ',
      '1080p60 to every landscape platform',
      'GPU exists only while you’re live — ~45s cold start',
    ],
  },
  {
    kicker: 'Fan-out',
    title: 'Every platform, its own rules',
    body: 'Twitch wants 8 Mbps landscape. TikTok wants portrait. SlimCast handles each destination independently so every platform gets a stream that fits — without you juggling encoder profiles.',
    points: [
      'Twitch, YouTube, Kick, TikTok',
      'Per-platform bitrate, frame rate & orientation',
      'Automatic portrait pillarboxing for TikTok',
      'Toggle platforms on and off per stream',
    ],
  },
  {
    kicker: 'Reliability',
    title: 'It keeps itself online',
    body: 'A supervisor watches every output. If a platform connection drops, it reconnects with backoff while the rest of your stream keeps running. You find out from the dashboard, not from angry chat.',
    points: [
      'Per-output health monitoring',
      'Automatic reconnect with exponential backoff',
      'One platform failing never takes down the others',
      'Live status in OBS and on the web dashboard',
    ],
  },
  {
    kicker: 'Billing',
    title: 'Pay for seconds, not months',
    body: 'No subscription. You buy streaming credits and they’re drawn down by the second at $2/hour, only while you’re actually live. Credits never expire, and auto-refill keeps long streams from ever cutting out.',
    points: [
      '$2/hour, billed to the second',
      'Credits never expire',
      'Optional auto-refill below 1 hour',
      '2 free hours on signup — no card required',
    ],
  },
  {
    kicker: 'Security',
    title: 'Your keys stay yours',
    body: 'Stream keys are encrypted at rest and only handed to the GPU at the moment you go live — never baked into an image or exposed to the OBS plugin. The plugin authenticates with a per-account API key you can rotate anytime.',
    points: [
      'Encrypted stream key storage',
      'Keys injected only at stream time',
      'Rotatable per-account API key',
      'GPU IP never exposed to the OBS plugin',
    ],
  },
]

function Check() {
  return (
    <svg viewBox="0 0 20 20" className="w-4 h-4 text-accent shrink-0 mt-0.5" fill="currentColor">
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 10a1 1 0 1 1 1.4-1.4l3.3 3.3 6.8-6.8a1 1 0 0 1 1.4 0z" clipRule="evenodd" />
    </svg>
  )
}

export default function FeaturesPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteNav />

      <main className="flex-1">
        <section className="relative overflow-hidden border-b border-line">
          <div className="absolute inset-0 bg-grid mask-fade pointer-events-none" />
          <div className="relative max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
            <div className="kicker mb-4">Features</div>
            <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-5">
              Everything you need to <span className="text-accent">stream everywhere</span>
            </h1>
            <p className="text-lg text-ink-muted max-w-2xl mx-auto">
              SlimCast is multistream infrastructure: a single HEVC feed in, a tuned stream to
              every platform out, and nothing for you to configure.
            </p>
          </div>
        </section>

        <div className="max-w-5xl mx-auto px-6 py-20 space-y-20">
          {SECTIONS.map((s, i) => (
            <section key={s.title} className="grid lg:grid-cols-2 gap-10 items-center">
              <div className={i % 2 ? 'lg:order-2' : ''}>
                <div className="kicker mb-3">{s.kicker}</div>
                <h2 className="text-2xl font-bold tracking-tight mb-4">{s.title}</h2>
                <p className="text-ink-muted leading-relaxed">{s.body}</p>
              </div>
              <div className={i % 2 ? 'lg:order-1' : ''}>
                <div className="rounded-xl border border-line bg-surface p-6">
                  <ul className="space-y-3">
                    {s.points.map(p => (
                      <li key={p} className="flex items-start gap-3 text-sm">
                        <Check />
                        <span className="text-ink-muted">{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ))}
        </div>

        <section className="border-t border-line bg-surface/40">
          <div className="max-w-2xl mx-auto px-6 py-20 text-center">
            <h2 className="text-3xl font-bold tracking-tight mb-4">Try it with two free hours</h2>
            <p className="text-ink-muted mb-8">No subscription. Spin up your first multistream tonight.</p>
            <Link
              href="/signup"
              className="inline-block bg-accent hover:bg-accent-strong text-base font-semibold px-8 py-3.5 rounded-lg transition-colors glow-accent"
            >
              Start free
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
