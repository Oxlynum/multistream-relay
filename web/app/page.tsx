import Link from 'next/link'
import { SiteNav } from '@/components/site-nav'
import { SiteFooter } from '@/components/site-footer'

const PLATFORMS = ['Twitch', 'YouTube', 'Kick', 'TikTok']

const STEPS = [
  {
    n: '01',
    title: 'Paste your stream keys',
    body: 'Add the platforms you want once in the dashboard. We store them encrypted — you never touch an RTMP URL again.',
  },
  {
    n: '02',
    title: 'Install the OBS plugin',
    body: 'One double-click on Mac or Windows. The SlimCast panel appears inside OBS. Paste your API key a single time.',
  },
  {
    n: '03',
    title: 'Hit “Start Streaming”',
    body: 'SlimCast spins up a cloud GPU in ~45 seconds, then sends your feed live to every platform automatically.',
  },
  {
    n: '04',
    title: 'Stop when you’re done',
    body: 'Ending the stream tears the GPU down instantly. You’re billed by the second — nothing runs idle.',
  },
]

const FEATURES = [
  {
    title: 'HEVC uplink',
    body: 'Push H.265 from OBS and send ~40% less data upstream. Built for creators whose upload can’t handle five H.264 streams.',
  },
  {
    title: 'Hardware GPU transcode',
    body: 'A dedicated NVENC GPU transcodes your feed per-platform — Twitch at 1080p60, TikTok in portrait — with zero load on your PC.',
  },
  {
    title: 'Five platforms at once',
    body: 'Twitch, YouTube, Kick, and TikTok simultaneously from a single OBS output. No second encoder, no second PC.',
  },
  {
    title: 'Per-platform tuning',
    body: 'Set bitrate, frame rate, and orientation independently for each destination. TikTok gets portrait, Twitch gets full 8 Mbps.',
  },
  {
    title: 'Auto-restart & failover',
    body: 'If a platform connection drops, SlimCast reconnects it automatically with backoff — the rest of your stream never blinks.',
  },
  {
    title: 'Pay per second',
    body: '$2/hour billed to the second. No subscription, no minimums. The GPU only exists while you’re actually live.',
  },
]

const TRUST = [
  { stat: '1080p60', label: 'Max output quality, every platform' },
  { stat: '~45s', label: 'Cold start from click to live' },
  { stat: '5', label: 'Platforms fanned out in parallel' },
  { stat: '0', label: 'Terminal commands, configs, or RTMP URLs' },
]

const COMPARE = [
  { feature: 'Pricing model', slimcast: 'Pay-per-second · $2/hr', restream: 'Monthly subscription', streamlabs: 'Monthly subscription' },
  { feature: 'HEVC uplink (low upload)', slimcast: true, restream: false, streamlabs: false },
  { feature: '1080p60 to all platforms', slimcast: true, restream: 'Higher tiers only', streamlabs: 'Higher tiers only' },
  { feature: 'Hardware GPU transcode', slimcast: true, restream: true, streamlabs: true },
  { feature: 'No idle billing', slimcast: true, restream: false, streamlabs: false },
  { feature: 'Controlled entirely from OBS', slimcast: true, restream: false, streamlabs: 'Partial' },
  { feature: 'Free trial', slimcast: '2 hours, no card', restream: 'Limited', streamlabs: 'Limited' },
]

const FAQ = [
  {
    q: 'Do I need a powerful PC?',
    a: 'No. The heavy lifting — transcoding to five platforms — happens on a cloud GPU. Your machine only encodes one stream out of OBS, exactly like streaming to a single platform.',
  },
  {
    q: 'What upload speed do I need?',
    a: 'Just enough for one stream. Because you push a single HEVC feed (not five H.264 streams), a typical 1080p60 upload of ~8–10 Mbps is plenty. SlimCast fans it out from the cloud, not your connection.',
  },
  {
    q: 'Are my stream keys safe?',
    a: 'Yes. Keys are stored encrypted in our database and injected into the GPU only at stream time — never baked into an image or exposed to the OBS plugin. The plugin authenticates with a per-account API key you can rotate anytime.',
  },
  {
    q: 'How does billing work?',
    a: 'You buy streaming credits and they’re drawn down by the second while you’re live, at $2/hour. There’s no subscription and credits never expire. New accounts get 2 free hours — no credit card required.',
  },
  {
    q: 'What happens when I run low on credits?',
    a: 'The OBS plugin warns you at 30 minutes remaining and again as you approach zero. You can enable auto-refill to top up automatically, or the stream stops cleanly when the balance hits zero.',
  },
  {
    q: 'Which platforms are supported?',
    a: 'Twitch, YouTube, Kick, and TikTok today. TikTok streams in portrait automatically; everything else goes out in landscape at up to 1080p60.',
  },
]

function Check() {
  return (
    <svg viewBox="0 0 20 20" className="w-5 h-5 text-accent inline" fill="currentColor" aria-label="yes">
      <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 10a1 1 0 1 1 1.4-1.4l3.3 3.3 6.8-6.8a1 1 0 0 1 1.4 0z" clipRule="evenodd" />
    </svg>
  )
}

function Cross() {
  return (
    <svg viewBox="0 0 20 20" className="w-4 h-4 text-ink-faint inline" fill="currentColor" aria-label="no">
      <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function Cell({ value }: { value: string | boolean }) {
  if (value === true) return <Check />
  if (value === false) return <Cross />
  return <span className="text-sm text-ink-muted">{value}</span>
}

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteNav />

      <main className="flex-1">
        {/* ── Hero ─────────────────────────────────────────────── */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-grid mask-fade pointer-events-none" />
          <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-accent/10 rounded-full blur-[120px] pointer-events-none" />

          <div className="relative max-w-4xl mx-auto px-6 pt-24 pb-20 text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-xs text-ink-muted mb-7">
              <span className="relative inline-flex w-1.5 h-1.5 text-accent">
                <span className="pulse-dot" />
                <span className="relative w-1.5 h-1.5 rounded-full bg-accent" />
              </span>
              Multistream infrastructure for creators
            </div>

            <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight leading-[1.05] mb-6">
              <span className="text-gradient">One stream in.</span>
              <br />
              <span className="text-ink">Every platform live.</span>
            </h1>

            <p className="text-lg text-ink-muted max-w-2xl mx-auto mb-9 leading-relaxed">
              Push a single HEVC stream from OBS. SlimCast transcodes it on a cloud GPU and
              goes live on Twitch, YouTube, Kick, and TikTok at once — no second PC,
              no config files, no terminal.
            </p>

            <div className="flex flex-wrap gap-3 justify-center">
              <Link
                href="/signup"
                className="bg-accent hover:bg-accent-strong text-base font-semibold px-7 py-3 rounded-lg transition-colors glow-accent"
              >
                Start free — 2 hours included
              </Link>
              <a
                href="#how"
                className="border border-line-strong hover:border-ink-faint text-ink px-7 py-3 rounded-lg font-semibold transition-colors"
              >
                See how it works
              </a>
            </div>

            <div className="mt-8 text-xs text-ink-faint">
              No credit card required · Cancel anytime — there’s nothing to cancel
            </div>

            {/* platform strip */}
            <div className="mt-14 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
              {PLATFORMS.map(p => (
                <span key={p} className="text-sm font-medium text-ink-faint">{p}</span>
              ))}
            </div>
          </div>
        </section>

        {/* ── What it actually does ────────────────────────────── */}
        <section className="max-w-5xl mx-auto px-6 py-20">
          <div className="text-center mb-12">
            <div className="kicker mb-3">The pipeline</div>
            <h2 className="text-3xl font-bold tracking-tight">What SlimCast actually does</h2>
            <p className="text-ink-muted mt-3 max-w-2xl mx-auto">
              You send one feed. We do the expensive part in the cloud and split it five ways.
            </p>
          </div>

          <div className="flex flex-col md:flex-row items-stretch justify-center gap-4">
            {/* OBS */}
            <div className="flex-1 rounded-xl border border-line bg-surface p-6 text-center">
              <div className="kicker mb-3">You</div>
              <div className="text-lg font-semibold mb-1">OBS on your PC</div>
              <p className="text-sm text-ink-muted">One HEVC stream out. Same effort as streaming to a single platform.</p>
            </div>

            <div className="flex items-center justify-center text-accent md:px-1">
              <span className="font-mono text-sm">→</span>
            </div>

            {/* SlimCast GPU */}
            <div className="flex-1 rounded-xl border border-accent/40 bg-accent-soft/30 p-6 text-center glow-accent">
              <div className="kicker mb-3">SlimCast</div>
              <div className="text-lg font-semibold mb-1">Cloud GPU transcode</div>
              <p className="text-sm text-ink-muted">Hardware NVENC decodes HEVC and re-encodes H.264 per platform, in parallel.</p>
            </div>

            <div className="flex items-center justify-center text-accent md:px-1">
              <span className="font-mono text-sm">→</span>
            </div>

            {/* Platforms */}
            <div className="flex-1 rounded-xl border border-line bg-surface p-6 text-center">
              <div className="kicker mb-3">Your audience</div>
              <div className="text-lg font-semibold mb-1">5 platforms live</div>
              <p className="text-sm text-ink-muted">Twitch, YouTube, Kick &amp; TikTok — each tuned to its own limits.</p>
            </div>
          </div>
        </section>

        {/* ── How it works ────────────────────────────────────── */}
        <section id="how" className="border-y border-line bg-surface/40">
          <div className="max-w-5xl mx-auto px-6 py-20">
            <div className="text-center mb-14">
              <div className="kicker mb-3">Setup</div>
              <h2 className="text-3xl font-bold tracking-tight">Live in four steps</h2>
              <p className="text-ink-muted mt-3">From signup to streaming everywhere — no documentation required.</p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
              {STEPS.map(s => (
                <div key={s.n} className="rounded-xl border border-line bg-base p-6">
                  <div className="font-mono text-accent text-sm mb-4">{s.n}</div>
                  <div className="font-semibold mb-2">{s.title}</div>
                  <p className="text-sm text-ink-muted leading-relaxed">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Features ─────────────────────────────────────────── */}
        <section className="max-w-5xl mx-auto px-6 py-20">
          <div className="text-center mb-14">
            <div className="kicker mb-3">Capabilities</div>
            <h2 className="text-3xl font-bold tracking-tight">Built like infrastructure</h2>
            <p className="text-ink-muted mt-3 max-w-2xl mx-auto">
              Everything a serious multistream needs, and nothing you have to think about.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {FEATURES.map(f => (
              <div key={f.title} className="rounded-xl border border-line bg-surface p-6 hover:border-line-strong transition-colors">
                <div className="font-semibold mb-2">{f.title}</div>
                <p className="text-sm text-ink-muted leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Trust / tech ─────────────────────────────────────── */}
        <section id="trust" className="border-y border-line bg-surface/40">
          <div className="max-w-5xl mx-auto px-6 py-20">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
                <div className="kicker mb-3">Under the hood</div>
                <h2 className="text-3xl font-bold tracking-tight mb-4">Real infrastructure, not a hack</h2>
                <p className="text-ink-muted leading-relaxed mb-6">
                  SlimCast runs on dedicated cloud GPUs with hardware NVENC encoding — the same
                  silicon broadcasters use. Your HEVC feed is decoded and re-encoded per platform
                  with quality-tuned settings, then watched by a supervisor that restarts any
                  output that drops. Stream keys stay encrypted and are only handed to the GPU
                  at the moment you go live.
                </p>
                <ul className="space-y-3 text-sm">
                  {[
                    'Hardware NVENC decode + encode — zero load on your PC',
                    'Per-output supervisor with automatic reconnect & backoff',
                    'Stream keys encrypted at rest, injected only at stream time',
                    'SRT internal loopback preserves temporal-layered HEVC cleanly',
                  ].map(item => (
                    <li key={item} className="flex items-start gap-3">
                      <span className="text-accent mt-0.5"><Check /></span>
                      <span className="text-ink-muted">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {TRUST.map(t => (
                  <div key={t.label} className="rounded-xl border border-line bg-base p-6">
                    <div className="text-3xl font-bold text-ink mb-1 font-mono">{t.stat}</div>
                    <div className="text-xs text-ink-muted leading-snug">{t.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Comparison ───────────────────────────────────────── */}
        <section id="compare" className="max-w-5xl mx-auto px-6 py-20">
          <div className="text-center mb-12">
            <div className="kicker mb-3">Compare</div>
            <h2 className="text-3xl font-bold tracking-tight">Why creators switch to SlimCast</h2>
            <p className="text-ink-muted mt-3">Pay for what you stream. Push less. Go live everywhere.</p>
          </div>

          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-left min-w-[640px]">
              <thead>
                <tr className="border-b border-line bg-surface">
                  <th className="px-5 py-4 text-sm font-medium text-ink-muted">Feature</th>
                  <th className="px-5 py-4 text-sm font-semibold text-accent">SlimCast</th>
                  <th className="px-5 py-4 text-sm font-medium text-ink-muted">Restream</th>
                  <th className="px-5 py-4 text-sm font-medium text-ink-muted">Streamlabs</th>
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((row, i) => (
                  <tr key={row.feature} className={i % 2 ? 'bg-surface/40' : ''}>
                    <td className="px-5 py-4 text-sm text-ink">{row.feature}</td>
                    <td className="px-5 py-4"><Cell value={row.slimcast} /></td>
                    <td className="px-5 py-4"><Cell value={row.restream} /></td>
                    <td className="px-5 py-4"><Cell value={row.streamlabs} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-faint mt-3 text-center">
            Comparison reflects publicly advertised plans. Competitor features vary by tier.
          </p>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────── */}
        <section id="faq" className="border-t border-line bg-surface/40">
          <div className="max-w-3xl mx-auto px-6 py-20">
            <div className="text-center mb-12">
              <div className="kicker mb-3">Questions</div>
              <h2 className="text-3xl font-bold tracking-tight">Frequently asked</h2>
            </div>

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

        {/* ── Final CTA ────────────────────────────────────────── */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-grid mask-fade pointer-events-none opacity-60" />
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[500px] h-[400px] bg-accent/10 rounded-full blur-[120px] pointer-events-none" />
          <div className="relative max-w-2xl mx-auto px-6 py-24 text-center">
            <h2 className="text-4xl font-extrabold tracking-tight mb-4">
              Go live everywhere tonight.
            </h2>
            <p className="text-ink-muted text-lg mb-8">
              Two free hours are waiting in your account. No card, no setup, no terminal.
            </p>
            <Link
              href="/signup"
              className="inline-block bg-accent hover:bg-accent-strong text-base font-semibold px-8 py-3.5 rounded-lg transition-colors glow-accent"
            >
              Create your account
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
