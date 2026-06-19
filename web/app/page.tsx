import Link from 'next/link'
import Image from 'next/image'
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
          <div className="absolute inset-0 bg-grid mask-fade pointer-events-none opacity-40" />
          <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-accent-soft/40 rounded-full blur-[140px] pointer-events-none" />
          <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[400px] h-[400px] bg-accent/20 rounded-full blur-[100px] pointer-events-none mix-blend-screen" />

          <div className="relative max-w-4xl mx-auto px-6 pt-24 pb-20 text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/80 glass px-4 py-1.5 text-xs font-medium text-ink-muted mb-8 shadow-sm">
              <span className="relative inline-flex w-2 h-2 text-accent">
                <span className="pulse-dot" />
                <span className="relative w-2 h-2 rounded-full bg-accent" />
              </span>
              <span className="text-ink">Next-gen infrastructure</span> <span className="opacity-50">|</span> <span>Multistream relay</span>
            </div>

            <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight leading-[1.1] mb-6">
              <span className="text-gradient">One stream in.</span>
              <br />
              <span className="text-gradient-accent">Every platform live.</span>
            </h1>

            <p className="text-lg text-ink-muted max-w-2xl mx-auto mb-9 leading-relaxed">
              Push a single HEVC stream from OBS. SlimCast transcodes it on a cloud GPU and
              goes live on Twitch, YouTube, Kick, and TikTok at once — no second PC,
              no config files, no terminal.
            </p>

            <div className="flex flex-wrap gap-4 justify-center mt-4">
              <Link
                href="/signup"
                className="bg-accent text-base text-base font-semibold px-8 py-3.5 rounded-lg transition-all glow-accent flex items-center gap-2"
              >
                Start free — 2 hours included
                <span className="font-mono text-sm opacity-80">→</span>
              </Link>
              <a
                href="#how"
                className="glass border border-line-strong hover:border-accent hover:text-accent hover:bg-surface/50 text-ink px-8 py-3.5 rounded-lg font-semibold transition-all"
              >
                See how it works
              </a>
            </div>

            <div className="mt-8 text-xs text-ink-faint">
              Account verification required · Cancel anytime
            </div>

            {/* platform strip */}
            <div className="mt-14 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 mb-16">
              {PLATFORMS.map(p => (
                <span key={p} className="text-sm font-medium text-ink-faint uppercase tracking-wider">{p}</span>
              ))}
            </div>

            <div className="relative max-w-5xl mx-auto mt-16 animate-float z-10">
              <div className="absolute inset-0 bg-accent/20 blur-[100px] -z-10 rounded-full" />
              <div className="rounded-2xl border border-line/50 shadow-2xl shadow-accent/10 glass overflow-hidden p-2 bg-surface/50">
                <Image 
                  src="/dashboard-preview.jpg" 
                  alt="SlimCast Dashboard Preview" 
                  width={1920} 
                  height={1080} 
                  className="rounded-xl w-full h-auto object-cover opacity-90 hover:opacity-100 transition-opacity duration-500"
                  priority
                />
              </div>
            </div>
          </div>
        </section>

        {/* ── Core Infrastructure ────────────────────────────── */}
        <section className="max-w-5xl mx-auto px-6 py-20">
          <div className="text-center mb-12">
            <div className="kicker mb-3">Core Infrastructure</div>
            <h2 className="text-3xl font-bold tracking-tight">Hardware-accelerated multiplexing</h2>
            <p className="text-ink-muted mt-3 max-w-2xl mx-auto">
              Transmit a single source feed. Our infrastructure manages concurrent transcoding and distribution.
            </p>
          </div>

          <div className="flex flex-col md:flex-row items-stretch justify-center gap-6 mt-8 relative">
            <div className="absolute top-1/2 left-0 w-full h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent -translate-y-1/2 hidden md:block" />
            
            {/* OBS */}
            <div className="flex-1 rounded-2xl glass border border-line/50 p-8 text-center relative z-10 transition-transform duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-accent/5">
              <div className="kicker mb-4">You</div>
              <div className="text-xl font-semibold mb-2 text-ink">OBS on your PC</div>
              <p className="text-sm text-ink-muted">One HEVC stream out. Same effort as streaming to a single platform.</p>
            </div>

            <div className="flex items-center justify-center text-accent/50 md:px-2 relative z-10 hidden md:flex">
              <span className="font-mono text-xl animate-pulse">→</span>
            </div>

            {/* SlimCast GPU */}
            <div className="flex-1 rounded-2xl glass border border-accent/40 bg-accent-soft p-8 text-center glow-accent relative z-10 scale-105">
              <div className="kicker mb-4">SlimCast</div>
              <div className="text-xl font-semibold mb-2 text-ink">Cloud GPU transcode</div>
              <p className="text-sm text-ink-muted">Hardware NVENC decodes HEVC and re-encodes H.264 per platform, in parallel.</p>
            </div>

            <div className="flex items-center justify-center text-accent/50 md:px-2 relative z-10 hidden md:flex">
              <span className="font-mono text-xl animate-pulse">→</span>
            </div>

            {/* Platforms */}
            <div className="flex-1 rounded-2xl glass border border-line/50 p-8 text-center relative z-10 transition-transform duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-accent/5">
              <div className="kicker mb-4">Your audience</div>
              <div className="text-xl font-semibold mb-2 text-ink">5 platforms live</div>
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

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              {STEPS.map((s, i) => (
                <div key={s.n} className="rounded-2xl glass border border-line/50 p-8 transition-all duration-300 hover:border-accent/30 hover:-translate-y-1 hover:shadow-lg hover:shadow-accent/5 relative overflow-hidden group">
                  <div className="absolute top-0 right-0 p-6 opacity-5 text-8xl font-bold font-mono group-hover:opacity-10 transition-opacity -mr-4 -mt-4 text-accent">{s.n}</div>
                  <div className="font-mono text-accent text-sm mb-5 opacity-80">{s.n} / 04</div>
                  <div className="text-lg font-semibold mb-3 text-ink">{s.title}</div>
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

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map(f => (
              <div key={f.title} className="rounded-2xl glass border border-line/50 p-8 transition-all duration-300 hover:border-accent/40 hover:-translate-y-1 hover:shadow-xl hover:shadow-accent/10">
                <div className="text-lg font-semibold mb-3 text-ink flex items-center gap-3">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block"></span>
                  {f.title}
                </div>
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
                <h2 className="text-3xl font-bold tracking-tight mb-4">Enterprise-grade distribution</h2>
                <p className="text-ink-muted leading-relaxed mb-6">
                  SlimCast operates on dedicated cloud GPUs utilizing hardware NVENC encoding. Your 
                  source HEVC feed is decoded and concurrently re-encoded per platform using 
                  optimized settings. The supervisor service monitors outputs and seamlessly reconnects 
                  dropped endpoints. Stream keys remain encrypted at rest and are injected securely 
                  only during active broadcasts.
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

              <div className="space-y-12">
                <div className="grid grid-cols-2 gap-5">
                  {TRUST.map(t => (
                    <div key={t.label} className="rounded-2xl glass border border-line/50 p-8 transition-all duration-300 hover:border-accent/20">
                      <div className="text-4xl font-bold text-gradient-accent mb-2 font-mono tracking-tight">{t.stat}</div>
                      <div className="text-sm text-ink-muted leading-relaxed">{t.label}</div>
                    </div>
                  ))}
                </div>

                <div className="relative animate-float-delayed z-10 hidden md:block">
                  <div className="absolute inset-0 bg-accent/10 blur-[80px] -z-10 rounded-full" />
                  <div className="rounded-2xl border border-line/50 shadow-2xl shadow-accent/5 glass overflow-hidden p-2 bg-surface/50">
                    <Image 
                      src="/obs-plugin-preview.jpg" 
                      alt="SlimCast OBS Plugin" 
                      width={1200} 
                      height={900} 
                      className="rounded-xl w-full h-auto object-cover opacity-90 hover:opacity-100 transition-opacity duration-500"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>



        {/* ── Final CTA ────────────────────────────────────────── */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-grid mask-fade pointer-events-none opacity-20" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[500px] bg-accent/10 rounded-full blur-[140px] pointer-events-none" />
          <div className="relative max-w-2xl mx-auto px-6 py-28 text-center glass rounded-3xl border border-line/50 m-6 mb-12 shadow-2xl shadow-base">
            <h2 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-6 text-gradient">
              Go live everywhere tonight.
            </h2>
            <p className="text-ink-muted text-lg mb-10 max-w-xl mx-auto">
              Two free hours are waiting in your account. Set up your streaming infrastructure in minutes.
            </p>
            <Link
              href="/signup"
              className="inline-flex items-center gap-3 bg-accent text-base font-semibold px-10 py-4 rounded-xl transition-all glow-accent"
            >
              Create your account
              <span className="font-mono text-sm opacity-80">→</span>
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
