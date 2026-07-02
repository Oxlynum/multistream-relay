import type { Metadata } from 'next'
import Link from 'next/link'

import { Kicker } from '@/components/ui/kicker'
import { GradientText } from '@/components/ui/gradient-text'
import { AuroraBackground } from '@/components/ui/aurora-background'
import { FeatureSplit } from '@/components/marketing/feature-split'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const metadata: Metadata = {
  title: 'Features',
  description:
    'One HEVC feed in, four platforms out. Cloud GPU transcoding, per-platform tuning, quality auto-adjust, Twitch HEVC passthrough, and token-based pricing — free during early access.',
}

type Accent = 'brand' | 'cyan' | 'pink'

const SECTIONS: {
  kicker: string
  kickerColor: Accent
  title: string
  body: string
  points: string[]
}[] = [
  {
    kicker: 'Uplink',
    kickerColor: 'brand',
    title: 'Push less, stream more',
    body: 'Most multistream tools make you send a separate H.264 stream for every platform — four destinations, four times the upload. SlimCast takes a single HEVC (H.265) feed instead, so you push roughly 40% less data upstream and we fan it out to four platforms in the cloud.',
    points: [
      'Single HEVC (H.265) feed out of OBS',
      'Apple VideoToolbox / NVENC hardware encoding',
      'Built for creators with limited upload bandwidth',
      'No second PC or capture box required',
    ],
  },
  {
    kicker: 'Transcode',
    kickerColor: 'cyan',
    title: 'A broadcast GPU, on demand',
    body: 'Hit Start in OBS and SlimCast provisions a dedicated cloud GPU with hardware NVENC in about 45 seconds. It decodes your HEVC feed once and re-encodes a tuned output for each platform in parallel, on silicon built for it — and the GPU only exists while you are live.',
    points: [
      'Hardware NVDEC decode + NVENC encode',
      'Quality-tuned: CBR, lookahead, spatial/temporal AQ',
      '1080p60 standard — 2K / 1440p available as an add-on',
      '~45s cold start; torn down the instant you stop',
    ],
  },
  {
    kicker: 'Fan-out',
    kickerColor: 'pink',
    title: 'Every platform, its own rules',
    body: 'Twitch and Kick want landscape RTMPS. YouTube takes an HEVC passthrough over HLS. TikTok wants portrait. SlimCast handles each destination independently, so every platform gets a stream that fits — without you juggling encoder profiles.',
    points: [
      'Twitch, YouTube, Kick, and TikTok at once',
      'Per-platform bitrate, frame rate & orientation',
      'Automatic 9:16 crop for portrait TikTok',
      'Toggle platforms on and off per stream',
    ],
  },
  {
    kicker: 'Reliability',
    kickerColor: 'brand',
    title: 'It keeps itself online',
    body: 'A per-output supervisor watches every destination. If one platform drops, it reconnects with backoff while the rest keep running. And if your bandwidth dips mid-stream, the quality auto-adjust steps resolution and bitrate down smoothly — then recovers — so your stream bends instead of breaking.',
    points: [
      'Per-output health monitoring, one drop never spreads',
      'Automatic reconnect with exponential backoff',
      'Quality auto-adjust degrades gracefully, never face-plants',
      'Live status in OBS and on the web dashboard',
    ],
  },
  {
    kicker: 'Billing',
    kickerColor: 'cyan',
    title: 'Pay for the seconds you stream',
    body: 'Billing is token-based and metered while you are live — nothing runs once you stop, so there is no idle billing. Tokens scale with how many platforms and how much quality you use. Start with two free tokens and pick pay-as-you-go or a $20/mo subscription whenever billing switches on.',
    points: [
      'Free during early access — billing is currently off',
      'Metered by the second while live — no idle billing',
      '2 free tokens on signup · purchased tokens never expire',
      'Pay-as-you-go ($2 / token) or $20/mo subscription',
    ],
  },
  {
    kicker: 'Security',
    kickerColor: 'pink',
    title: 'Your keys stay yours',
    body: 'Stream keys are encrypted at rest with AES-256-GCM and only handed to the GPU at the moment you go live — never baked into an image or exposed to the OBS plugin. The plugin authenticates with a per-account API key you can rotate anytime, and the GPU IP never reaches your machine.',
    points: [
      'AES-256-GCM encrypted stream-key storage',
      'Keys injected only at stream time',
      'Rotatable per-account API key',
      'GPU IP never exposed to the OBS plugin',
    ],
  },
]

const SECTION_HEADING =
  'font-display text-[clamp(1.875rem,3.5vw,2.75rem)] font-bold tracking-[-0.015em] text-ink'

export default function FeaturesPage() {
  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-3xl px-6 pt-20 pb-16 text-center md:pt-28">
          <div className="flex justify-center">
            <Kicker>Features</Kicker>
          </div>
          <h1 className="mt-5 font-display text-[clamp(2.5rem,5.5vw,4rem)] leading-[1.05] font-bold tracking-[-0.02em] text-ink">
            Everything you need to{' '}
            <GradientText as="span">stream everywhere</GradientText>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-ink-muted">
            One HEVC feed in, a tuned stream to every platform out, and nothing for you to
            configure. SlimCast is the multistream infrastructure that runs only while you are
            live.
          </p>
        </div>
      </section>

      {/* ── Alternating feature splits ────────────────────────── */}
      <section className="py-24 md:py-28">
        <div className="mx-auto flex max-w-6xl flex-col gap-20 px-6 md:gap-28">
          {SECTIONS.map((s, i) => (
            <FeatureSplit
              key={s.kicker}
              kicker={s.kicker}
              kickerColor={s.kickerColor}
              title={s.title}
              body={s.body}
              points={s.points}
              reversed={i % 2 === 1}
              glow={i % 2 === 0}
            />
          ))}
        </div>
      </section>

      {/* ── Twitch HEVC eRTMP passthrough callout ─────────────── */}
      <section className="border-y border-line bg-bg-subtle py-24 md:py-28">
        <div className="mx-auto max-w-4xl px-6">
          <div className="relative overflow-hidden rounded-2xl border border-brand/30 bg-surface p-8 shadow-glow md:p-10">
            <div
              aria-hidden
              className="pointer-events-none absolute -top-16 -right-10 h-48 w-48 bg-gradient-brand opacity-20 blur-3xl"
            />
            <div className="relative">
              <Kicker color="brand">Twitch HEVC passthrough</Kicker>
              <h2 className={cn('mt-4', SECTION_HEADING)}>
                Maximum quality per bit — when Twitch allows it
              </h2>
              <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink-muted">
                If your Twitch account is eligible for HEVC over enhanced RTMP, SlimCast detects it
                automatically and passes your H.265 feed through untouched — no re-encode, no quality
                loss. Not eligible? You fall back to a clean H.264 transcode with zero configuration.
                Eligibility is probed against Twitch, never assumed.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────── */}
      <AuroraBackground as="section" className="relative overflow-hidden">
        <div className="mx-auto max-w-3xl px-6 py-28 text-center md:py-32">
          <h2 className="font-display text-[clamp(2rem,4.5vw,3rem)] font-bold tracking-[-0.02em]">
            <GradientText>Go live everywhere tonight.</GradientText>
          </h2>
          <p className="mt-5 text-lg text-ink-muted">
            Free during early access — and two free tokens are waiting.
          </p>
          <div className="mt-9 flex justify-center">
            <Link
              href="/signup"
              className={cn(
                buttonVariants({ variant: 'default' }),
                'h-12 px-8 text-base shadow-glow',
              )}
            >
              ▶ Insert Coin
            </Link>
          </div>
        </div>
      </AuroraBackground>
    </>
  )
}
