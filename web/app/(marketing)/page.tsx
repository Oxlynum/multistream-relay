import type { ReactNode } from 'react'
import Link from 'next/link'
import Image from 'next/image'

import { Kicker } from '@/components/ui/kicker'
import { GradientText } from '@/components/ui/gradient-text'
import { AuroraBackground } from '@/components/ui/aurora-background'
import { LiveDot } from '@/components/ui/live-dot'
import { StatTile } from '@/components/marketing/stat-tile'
import { FeatureCard } from '@/components/marketing/feature-card'
import { StepCard } from '@/components/marketing/step-card'
import { PlatformMarquee } from '@/components/marketing/platform-marquee'
import { PlatformIcon, PLATFORM_META, type PlatformKey } from '@/components/platform-icon'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const PLATFORMS: PlatformKey[] = ['twitch', 'youtube', 'kick', 'tiktok']

const SUBHEAD =
  'Bad WiFi? Mobile hotspot? SlimCast holds your stream together through the connection drops that freeze everyone else — up to 8% packet loss with no buffering — and puts you live on Twitch, YouTube, Kick, and TikTok at the same time. 1080p60 today, 1440p coming soon.'

const STEPS = [
  {
    n: '01',
    title: 'Connect your platforms',
    body: 'Link Twitch, YouTube, Kick, and TikTok once in the dashboard. We keep your keys locked down — you never mess with stream URLs again.',
  },
  {
    n: '02',
    title: 'Install the OBS plugin',
    body: 'One double-click on Mac or Windows. A SlimCast panel shows up right inside OBS — paste your key once and you’re set.',
  },
  {
    n: '03',
    title: 'Hit Start in OBS',
    body: 'That’s it. In about 45 seconds you’re live on every platform at once — nothing else to click.',
  },
  {
    n: '04',
    title: 'Stop when you’re done',
    body: 'Hit Stop and everything shuts off. You’re only ever charged while you’re actually live.',
  },
]

const FEATURES = [
  {
    title: 'Survives bad internet',
    body: 'Up to 8% packet loss with no drops and no buffering. Stream with confidence from home WiFi, a hotel, or a phone hotspot.',
  },
  {
    title: 'Go live everywhere',
    body: 'Twitch, YouTube, Kick, and TikTok all at once — Facebook coming soon. One stream from OBS, we send it everywhere.',
  },
  {
    title: 'Easy on your PC',
    body: 'The heavy lifting happens in the cloud, so your computer stays free for your game and your framerate stays high.',
  },
  {
    title: 'Quality that self-heals',
    body: 'If your connection dips, SlimCast eases the quality down and brings it right back — your stream never face-plants.',
  },
  {
    title: 'Tuned per platform',
    body: 'Each platform gets its own settings — full quality on Twitch, portrait for TikTok. Set it once and forget it.',
  },
  {
    title: '1080p60 today',
    body: 'Crisp 1080p at 60fps right now, with 1440p landing soon. Casual-friendly by default, room to grow.',
  },
]

const CHECKLIST = [
  'Rides out rough connections — up to 8% packet loss, no drops or buffering',
  'Every platform reconnects on its own if it blips — the rest keep running',
  'All the heavy work runs in the cloud, never on your PC',
  'Your stream keys stay private and encrypted — never exposed',
]

const STATS = [
  { value: '8%', label: 'Packet loss absorbed — no drops, no buffering' },
  { value: '1080p60', label: 'Crisp today · 1440p coming soon' },
  { value: '4', label: 'Platforms at once · Facebook soon' },
  { value: '~45s', label: 'From hitting Start to fully live' },
]

const SECTION_HEADING =
  'font-display text-[clamp(1.875rem,3.5vw,2.75rem)] font-bold tracking-[-0.015em] text-ink'

/* ── Core-flow building blocks ─────────────────────────────────────────── */

function FlowNode({
  label,
  title,
  body,
  featured = false,
  children,
}: {
  label: string
  title: string
  body: string
  featured?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex-1 rounded-2xl border bg-surface p-7 text-center transition-all',
        featured
          ? 'border-brand/40 shadow-glow lg:-translate-y-1'
          : 'border-line hover:border-line-strong',
      )}
    >
      <div
        className={cn(
          'font-mono text-xs font-semibold tracking-[0.2em] uppercase',
          featured ? 'text-cyan' : 'text-brand',
        )}
      >
        {label}
      </div>
      <h3 className="mt-3 font-display text-lg font-semibold text-ink">{title}</h3>
      <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-ink-muted">{body}</p>
      {children}
    </div>
  )
}

/* Gradient connector carrying a pulsing brand LiveDot — the literal "signal."
   Vertical on mobile (stacked nodes), horizontal on desktop. */
function FlowConnector() {
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center justify-center self-center py-2 lg:w-20 lg:py-0"
    >
      <div className="relative h-12 w-px bg-gradient-to-b from-brand/10 via-brand to-cyan/50 lg:h-px lg:w-full lg:bg-gradient-to-r">
        <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <LiveDot color="brand" size={9} />
        </span>
      </div>
    </div>
  )
}

function CheckItem({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden
        className="mt-0.5 h-5 w-5 shrink-0 text-success"
      >
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 10a1 1 0 1 1 1.4-1.4l3.3 3.3 6.8-6.8a1 1 0 0 1 1.4 0z"
        />
      </svg>
      <span className="text-sm leading-relaxed text-ink-muted">{children}</span>
    </li>
  )
}

export default function Home() {
  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────── */}
      <AuroraBackground as="section" className="relative overflow-hidden border-b border-line">
        <div className="mx-auto max-w-6xl px-6 pt-20 pb-20 md:pt-28 md:pb-24">
          <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
            {/* Solid status pill — no alpha, no blur (over the aurora) */}
            <span className="inline-flex items-center gap-2.5 rounded-full border border-line bg-surface px-4 py-1.5 text-xs font-medium">
              <LiveDot color="live" size={8} />
              <span className="text-ink">Stream smooth on any connection</span>
            </span>

            <h1 className="mt-7 font-pixel text-[clamp(1.1rem,3.4vw,2.25rem)] leading-[1.45] tracking-tight text-ink crt-chroma">
              Stream anywhere.
              <GradientText as="span" className="mt-3 block">
                Go live everywhere.
              </GradientText>
            </h1>

            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-muted">{SUBHEAD}</p>

            <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <Link
                href="/signup"
                className={cn(
                  buttonVariants({ variant: 'default' }),
                  'h-12 px-7 text-base shadow-glow',
                )}
              >
                Sign up
              </Link>
              <a
                href="#how"
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'h-12 px-7 text-base',
                )}
              >
                See how it works
              </a>
            </div>

            <p className="mt-5 text-xs text-ink-faint">
              Free during early access · 2 free tokens · account verification required
            </p>
          </div>

          {/* Hero showcase — a live "program monitor": telemetry bar + LIVE chip.
              Solid surfaces + selective glow only (no translucency, no blur). */}
          <div className="relative mx-auto mt-16 max-w-5xl md:mt-20">
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-4 -z-10 bg-gradient-brand opacity-20 blur-3xl"
            />
            <div className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-live">
              {/* Telemetry bar */}
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
                <span className="flex items-center gap-2.5">
                  <LiveDot color="cyan" size={7} />
                  <span className="font-mono text-[0.7rem] font-semibold tracking-[0.2em] text-ink-faint uppercase">
                    Live · Stable
                  </span>
                </span>
                <span aria-hidden className="flex items-center gap-1.5">
                  {PLATFORMS.map((p) => (
                    <span
                      key={p}
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: PLATFORM_META[p].tint }}
                    />
                  ))}
                </span>
              </div>

              <div className="relative p-2">
                <Image
                  src="/dashboard-preview.png"
                  alt="SlimCast dashboard"
                  width={1057}
                  height={659}
                  priority
                  className="h-auto w-full rounded-xl"
                />
                <span className="absolute top-4 left-4 inline-flex items-center gap-2 rounded-full border border-line-strong bg-bg px-3 py-1.5 text-xs font-semibold tracking-wider text-ink uppercase shadow-sm">
                  <LiveDot color="live" size={7} />
                  LIVE
                </span>
              </div>
            </div>
          </div>
        </div>
      </AuroraBackground>

      {/* ── Platform marquee band ─────────────────────────────── */}
      <PlatformMarquee />

      {/* ── How it works ──────────────────────────────────────── */}
      <section id="how" className="scroll-mt-20 py-24 md:py-32">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <Kicker>Setup</Kicker>
            <h2 className={cn('mt-4', SECTION_HEADING)}>Live in four steps.</h2>
          </div>

          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <StepCard key={s.n} n={s.n} title={s.title} body={s.body} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Core flow band ────────────────────────────────────── */}
      <section className="relative border-y border-line bg-bg-subtle py-24 md:py-32">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-dotgrid opacity-60" />
        <div className="relative mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-3xl text-center">
            <Kicker color="cyan">How it works</Kicker>
            <h2 className={cn('mt-4', SECTION_HEADING)}>
              We do the hard part in the cloud.
            </h2>
          </div>

          <div className="mt-16 flex flex-col items-stretch lg:flex-row lg:items-center">
            <FlowNode label="Your PC" title="You hit Start" body="Send one stream from OBS." />
            <FlowConnector />
            <FlowNode
              featured
              label="SlimCast"
              title="We handle it"
              body="We steady your stream through rough internet and copy it for every platform."
            />
            <FlowConnector />
            <FlowNode
              label="Your audience"
              title="You’re live everywhere"
              body="Twitch, YouTube, Kick & TikTok — Facebook coming soon."
            >
              <div className="mt-4 flex items-center justify-center gap-3">
                {PLATFORMS.map((p) => (
                  <span key={p} style={{ color: PLATFORM_META[p].tint }}>
                    <PlatformIcon platform={p} className="h-5 w-5" />
                  </span>
                ))}
              </div>
            </FlowNode>
          </div>
        </div>
      </section>

      {/* ── Features grid ─────────────────────────────────────── */}
      <section className="py-24 md:py-32">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <Kicker color="pink">Why SlimCast</Kicker>
            <h2 className={cn('mt-4', SECTION_HEADING)}>Built for real-world streaming.</h2>
          </div>

          <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <FeatureCard
                key={f.title}
                title={f.title}
                body={f.body}
                index={String(i + 1).padStart(2, '0')}
              />
            ))}
          </div>
        </div>
      </section>

      {/* ── Trust / tech ──────────────────────────────────────── */}
      <section id="trust" className="scroll-mt-20 border-y border-line bg-bg-subtle py-24 md:py-32">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid items-start gap-12 lg:grid-cols-2 lg:gap-16">
            {/* Left: claim + checklist */}
            <div>
              <Kicker color="cyan">Reliable by design</Kicker>
              <h2 className={cn('mt-4', SECTION_HEADING)}>Built to stay live.</h2>
              <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-muted">
                SlimCast is made for real-world internet. It rides out the rough patches that would
                freeze a normal stream, and watches every platform separately — so if one hiccups,
                the rest keep right on going.
              </p>
              <ul className="mt-8 space-y-4">
                {CHECKLIST.map((item) => (
                  <CheckItem key={item}>{item}</CheckItem>
                ))}
              </ul>
            </div>

            {/* Right: scoreboard + plugin program-monitor */}
            <div>
              <div className="grid grid-cols-2 gap-4">
                {STATS.map((s) => (
                  <StatTile key={s.label} value={s.value} label={s.label} />
                ))}
              </div>

              <div className="mt-4 hidden md:block">
                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-lg">
                  <div className="flex items-center gap-2.5 border-b border-line px-4 py-2.5">
                    <LiveDot color="cyan" size={7} />
                    <span className="font-mono text-[0.7rem] font-semibold tracking-[0.2em] text-ink-faint uppercase">
                      OBS plugin
                    </span>
                  </div>
                  <div className="p-2">
                    <Image
                      src="/obs-plugin-preview.png"
                      alt="SlimCast OBS plugin"
                      width={351}
                      height={420}
                      className="mx-auto h-auto w-full max-w-[300px] rounded-xl"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Pricing teaser ────────────────────────────────────── */}
      <section className="py-24 md:py-32">
        <div className="mx-auto max-w-4xl px-6">
          <div className="flex flex-col items-center gap-6 rounded-2xl border border-line bg-surface p-8 text-center md:flex-row md:justify-between md:p-10 md:text-left">
            <div>
              <h2 className="font-display text-2xl font-semibold text-ink md:text-3xl">
                {"Free while we're in early access."}
              </h2>
              <p className="mt-2 text-ink-muted">
                When billing turns on: pay-as-you-go tokens ($2 each) or $20/mo.
              </p>
            </div>
            <Link
              href="/pricing"
              className={cn(
                buttonVariants({ variant: 'outline' }),
                'h-12 shrink-0 rounded-xl px-7 text-base font-semibold',
              )}
            >
              See pricing
            </Link>
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────── */}
      <AuroraBackground as="section" className="relative overflow-hidden border-t border-line">
        <div className="mx-auto max-w-3xl px-6 py-28 text-center md:py-36">
          <h2 className="font-display text-[clamp(2.25rem,5vw,3.5rem)] font-bold tracking-[-0.02em]">
            <GradientText>Go live everywhere tonight.</GradientText>
          </h2>
          <p className="mt-5 text-lg text-ink-muted">Two free tokens are waiting.</p>
          <div className="mt-9 flex justify-center">
            <Link
              href="/signup"
              className={cn(
                buttonVariants({ variant: 'default' }),
                'h-12 px-8 text-base shadow-glow',
              )}
            >
              Sign up
            </Link>
          </div>
        </div>
      </AuroraBackground>
    </>
  )
}
