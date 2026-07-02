import type { Metadata } from 'next'
import Link from 'next/link'

import { Kicker } from '@/components/ui/kicker'
import { GradientText } from '@/components/ui/gradient-text'
import { AuroraBackground } from '@/components/ui/aurora-background'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export const metadata: Metadata = {
  title: 'FAQ',
  description:
    'Answers on local hardware, upload bandwidth, stream-key security, token-based billing, and the platforms and protocols SlimCast streams to.',
}

const FAQ = [
  {
    q: 'What are the local hardware requirements?',
    a: 'SlimCast offloads all transcoding and fan-out to a cloud GPU, so your local requirements are the same as streaming to a single destination. If your machine can run OBS and push one HEVC feed, it can run SlimCast.',
  },
  {
    q: 'How much upload bandwidth do I need?',
    a: 'A single uplink of about 8–10 Mbps is enough to push one high-quality HEVC source feed. SlimCast handles the bandwidth for fanning that out to every platform from the cloud — your upload stays flat no matter how many platforms you add.',
  },
  {
    q: 'How are my stream keys kept secure?',
    a: 'Stream keys are encrypted at rest with AES-256-GCM and injected into the GPU only during an active stream. They are never exposed to the OBS plugin, baked into a container image, or returned to your browser. The plugin authenticates with a per-account API key you can rotate anytime.',
  },
  {
    q: 'How does billing work?',
    a: 'Billing is currently off — SlimCast is free during early access. When it switches on it is token-based and metered by the second while you are live: 1 token = $2 ≈ one hour of base single-platform transcode, and a full four-platform stream runs about 1.5 tokens/hr. You get 2 free tokens on signup, plus an optional $20/mo subscription if you stream regularly.',
  },
  {
    q: 'What happens when I run low on credits?',
    a: 'The OBS dock warns you at roughly 30 minutes of streaming time remaining. If your balance reaches zero, the stream stops gracefully rather than cutting out mid-broadcast — and you can enable auto-refill so long streams never hit the wall.',
  },
  {
    q: 'Which platforms and protocols are supported?',
    a: 'OBS pushes one HEVC feed to SlimCast over SRT. We deliver to Twitch and Kick over RTMPS, YouTube as an HEVC passthrough over HLS, and TikTok over RTMP. Landscape platforms get 1080p60 by default (2K / 1440p is an add-on), and TikTok is delivered in portrait.',
  },
]

const SECTION_HEADING =
  'font-display text-[clamp(1.875rem,3.5vw,2.75rem)] font-bold tracking-[-0.015em] text-ink'

export default function FAQPage() {
  return (
    <>
      {/* ── Hero ──────────────────────────────────────────────── */}
      <section className="border-b border-line">
        <div className="mx-auto max-w-3xl px-6 pt-20 pb-14 text-center md:pt-28">
          <div className="flex justify-center">
            <Kicker>Resources</Kicker>
          </div>
          <h1 className="mt-5 font-display text-[clamp(2.5rem,5.5vw,4rem)] leading-[1.05] font-bold tracking-[-0.02em] text-ink">
            Frequently <GradientText as="span">asked</GradientText>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-ink-muted">
            The short answers on hardware, bandwidth, security, billing, and the platforms SlimCast
            streams to.
          </p>
        </div>
      </section>

      {/* ── Q&A ───────────────────────────────────────────────── */}
      <section className="py-24 md:py-28">
        <div className="mx-auto max-w-3xl px-6">
          <Accordion className="rounded-2xl border border-line bg-surface px-6">
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

      {/* ── Closing CTA ───────────────────────────────────────── */}
      <AuroraBackground as="section" className="relative overflow-hidden border-t border-line">
        <div className="mx-auto max-w-3xl px-6 py-24 text-center md:py-28">
          <h2 className={SECTION_HEADING}>
            Still have a <GradientText as="span">question?</GradientText>
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg text-ink-muted">
            The fastest way to see how it works is to try it — free during early access, with two
            free tokens on signup.
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
