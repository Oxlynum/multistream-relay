import type { Metadata } from 'next'
import Link from 'next/link'

import { Kicker } from '@/components/ui/kicker'
import { GradientText } from '@/components/ui/gradient-text'
import { AuroraBackground } from '@/components/ui/aurora-background'
import { LiveDot } from '@/components/ui/live-dot'
import { PricingCard } from '@/components/marketing/pricing-card'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Free during early access. When billing switches on it is token-based — pay-as-you-go at $2 per token or a $20/mo subscription. Two free tokens on signup.',
}

const INCLUDED = [
  'All four platforms simultaneously',
  '1080p60 standard output',
  '2K / 1440p available as an add-on',
  'HEVC uplink — push less data',
  'Cloud GPU hardware transcode',
  'Per-platform bitrate, FPS & orientation',
  'Auto-reconnect + quality auto-adjust',
  'Auto-launch from OBS — no idle billing',
  'Optional auto-refill for long streams',
  'Purchased tokens never expire',
]

const EXAMPLES = [
  {
    label: 'Single platform',
    cost: '≈ $2 / hr',
    note: '1 token/hr — base transcode',
  },
  {
    label: 'Full four-platform',
    cost: '≈ $3 / hr',
    note: '~1.5 tokens/hr across all four',
  },
  {
    label: 'Four-platform + 2K',
    cost: '≈ $4 / hr',
    note: '~2 tokens/hr with the 1440p add-on',
  },
]

const FAQ = [
  {
    q: 'How am I billed?',
    a: 'By the second while you are live. Each heartbeat deducts a fraction of a token at your current burn rate, and the moment you hit Stop the GPU is torn down — so nothing keeps billing. There is no idle cost.',
  },
  {
    q: 'Do my tokens expire?',
    a: 'Purchased tokens never expire. If you subscribe, your monthly allotment rolls over from month to month, capped at 30 tokens.',
  },
  {
    q: 'Is there a subscription?',
    a: 'Yes — an optional $20/mo plan with 15 tokens a month (rolling over up to 30) and half-price passthrough. Pay-as-you-go has no recurring charge at all, so pick whichever fits how you stream.',
  },
  {
    q: 'What do my 2 free tokens get me?',
    a: 'Roughly 2 hours of single-platform streaming, or about 80 minutes of a full four-platform multistream — with every feature included.',
  },
]

const SECTION_HEADING =
  'font-display text-[clamp(1.875rem,3.5vw,2.75rem)] font-bold tracking-[-0.015em] text-ink'

function Check() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
      className="mt-0.5 h-4 w-4 shrink-0 text-success"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 10a1 1 0 1 1 1.4-1.4l3.3 3.3 6.8-6.8a1 1 0 0 1 1.4 0z"
      />
    </svg>
  )
}

export default function PricingPage() {
  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-3xl px-6 pt-20 pb-14 text-center md:pt-28">
          <div className="flex justify-center">
            <Kicker>Pricing</Kicker>
          </div>
          <h1 className="mt-5 font-display text-[clamp(2.5rem,5.5vw,4rem)] leading-[1.05] font-bold tracking-[-0.02em] text-ink">
            Simple tokens. <GradientText as="span">No surprises.</GradientText>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-ink-muted">
            You pay only for the seconds you stream. No idle billing, no lock-in — and right now,
            during early access, nothing at all.
          </p>
        </div>
      </section>

      {/* ── Early-access banner ───────────────────────────────── */}
      <section className="pt-12">
        <div className="mx-auto max-w-4xl px-6">
          <div className="flex items-start gap-4 rounded-2xl border border-cyan/40 bg-surface-2 p-6 md:p-7">
            <span className="mt-1 shrink-0">
              <LiveDot color="cyan" size={9} />
            </span>
            <div>
              <h2 className="font-display text-lg font-semibold text-ink">
                Free during early access.
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                Billing is off right now — stream all four platforms on the house. Here is what
                pricing will look like when it switches on.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Plan cards ────────────────────────────────────────── */}
      <section className="pt-12">
        <div className="mx-auto grid max-w-4xl gap-6 px-6 md:grid-cols-2 md:gap-7">
          <PricingCard
            name="Pay-as-you-go"
            price="$2"
            unit="per token"
            blurb="1 token ≈ 1 hour of base, single-platform transcode. A full four-platform stream uses about 1.5 tokens/hr (~$3/hr). You only pay while you are live."
            badge="2 free tokens on signup"
            features={[
              'Buy tokens whenever — no commitment',
              'Purchased tokens never expire',
              'Passthrough billed at 0.10 tok/hr',
              'Optional auto-refill for long streams',
            ]}
            ctaHref="/signup"
            ctaLabel="Sign up"
          />
          <PricingCard
            featured
            name="Subscription"
            price="$20"
            unit="/ mo"
            blurb="15 tokens every month, rolling over up to 30 — about 10 hours of full multistream included, plus half-price passthrough."
            features={[
              '15 tokens / mo — roll over up to 30',
              '≈10 hrs/mo of full four-platform multistream',
              'Half-price passthrough (0.05 vs 0.10 tok/hr)',
              'Top up anytime with pay-as-you-go tokens',
            ]}
            ctaHref="/signup"
            ctaLabel="Sign up"
          />
        </div>
        <p className="mx-auto mt-6 max-w-4xl px-6 text-center text-xs text-ink-faint">
          1 token = $2. Billing is currently free during early access.
        </p>
      </section>

      {/* ── What's included ───────────────────────────────────── */}
      <section className="py-24 md:py-28">
        <div className="mx-auto max-w-4xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <Kicker color="cyan">Every plan includes</Kicker>
            <h2 className={cn('mt-4', SECTION_HEADING)}>The whole platform, on either tier.</h2>
          </div>
          <ul className="mt-12 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            {INCLUDED.map((item) => (
              <li key={item} className="flex items-start gap-3">
                <Check />
                <span className="text-sm leading-relaxed text-ink-muted">{item}</span>
              </li>
            ))}
          </ul>
          <p className="mt-8 text-center text-xs text-ink-faint">
            Purchased tokens never expire. On the subscription, the monthly allotment rolls over and
            is capped at 30 tokens.
          </p>
        </div>
      </section>

      {/* ── Cost examples ─────────────────────────────────────── */}
      <section className="border-y border-line bg-bg-subtle py-24 md:py-28">
        <div className="mx-auto max-w-5xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <Kicker color="pink">What it costs</Kicker>
            <h2 className={cn('mt-4', SECTION_HEADING)}>Roughly what a stream runs.</h2>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {EXAMPLES.map((ex) => (
              <div
                key={ex.label}
                className="rounded-2xl border border-line bg-surface p-7 text-center transition-colors hover:border-line-strong"
              >
                <div className="font-mono text-xs font-semibold tracking-[0.15em] text-brand uppercase">
                  {ex.label}
                </div>
                <div className="text-aurora mt-4 font-mono text-4xl font-semibold tracking-tight">
                  {ex.cost}
                </div>
                <div className="mt-3 text-sm leading-relaxed text-ink-muted">{ex.note}</div>
              </div>
            ))}
          </div>
          <p className="mt-8 text-center text-xs text-ink-faint">
            Estimates at 1.0–1.5 tokens/hr. Billing is currently free during early access.
          </p>
        </div>
      </section>

      {/* ── Billing FAQ ───────────────────────────────────────── */}
      <section className="py-24 md:py-28">
        <div className="mx-auto max-w-3xl px-6">
          <div className="mx-auto max-w-2xl text-center">
            <Kicker>Billing FAQ</Kicker>
            <h2 className={cn('mt-4', SECTION_HEADING)}>The money questions.</h2>
          </div>
          <Accordion className="mt-12 rounded-2xl border border-line bg-surface px-6">
            {FAQ.map((item) => (
              <AccordionItem key={item.q} value={item.q} className="border-line">
                <AccordionTrigger className="py-5 text-base font-medium text-ink hover:no-underline">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="pr-6 text-sm leading-relaxed text-ink-muted">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* ── Final CTA ─────────────────────────────────────────── */}
      <AuroraBackground as="section" className="relative overflow-hidden border-t border-line">
        <div className="mx-auto max-w-3xl px-6 py-28 text-center md:py-32">
          <h2 className="font-display text-[clamp(2rem,4.5vw,3rem)] font-bold tracking-[-0.02em]">
            <GradientText>Two free tokens are waiting.</GradientText>
          </h2>
          <p className="mt-5 text-lg text-ink-muted">
            Start free during early access — no charge while billing is off.
          </p>
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
