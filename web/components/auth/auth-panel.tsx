'use client'

import { useEffect, useState } from 'react'

import { Logo } from '@/components/logo'
import { AuroraBackground } from '@/components/ui/aurora-background'
import { GradientText } from '@/components/ui/gradient-text'
import { LiveDot } from '@/components/ui/live-dot'
import { PlatformIcon, PLATFORM_META, type PlatformKey } from '@/components/platform-icon'
import { cn } from '@/lib/utils'

const PLATFORMS: PlatformKey[] = ['twitch', 'youtube', 'kick', 'tiktok']

export type AuthBlurb = { title: string; body: string }

const DEFAULT_BLURBS: AuthBlurb[] = [
  {
    title: 'One feed in, four live out',
    body: 'Push a single HEVC stream from OBS — SlimCast fans it out to Twitch, YouTube, Kick, and TikTok at once.',
  },
  {
    title: 'A GPU that only exists while you’re live',
    body: 'Spun up in ~45 seconds when you hit Start, torn down the instant you Stop. No second PC, no idle billing.',
  },
  {
    title: 'Tuned per platform, automatically',
    body: 'Independent bitrate and orientation for every destination — and quality auto-adjusts so your stream never face-plants.',
  },
]

/**
 * Shared split-screen brand panel for the auth/consent pages (login / signup / link).
 * Renders the left column on desktop (hidden under `lg`) — logo, tagline, and a
 * gently rotating "what creators ship" blurb. Pass `blurbs` to customise.
 */
export function AuthPanel({
  blurbs = DEFAULT_BLURBS,
  className,
}: {
  blurbs?: AuthBlurb[]
  className?: string
}) {
  const [i, setI] = useState(0)

  useEffect(() => {
    if (blurbs.length <= 1) return
    const id = setInterval(() => setI((prev) => (prev + 1) % blurbs.length), 5000)
    return () => clearInterval(id)
  }, [blurbs.length])

  const blurb = blurbs[i]

  return (
    <AuroraBackground
      as="aside"
      className={cn(
        'relative hidden flex-col justify-between overflow-hidden border-r border-line bg-bg-subtle p-10 lg:flex xl:p-14',
        className,
      )}
    >
      {/* Top — brand mark */}
      <div className="relative z-10">
        <Logo />
      </div>

      {/* Middle — headline */}
      <div className="relative z-10 max-w-md">
        <span className="inline-flex items-center gap-2.5 rounded-full border border-line bg-surface px-4 py-1.5 text-xs font-medium">
          <LiveDot color="live" size={8} />
          <span className="text-ink">Streaming infrastructure for creators</span>
        </span>

        <h2 className="mt-6 font-display text-[clamp(1.875rem,2.6vw,2.6rem)] leading-[1.05] font-bold tracking-[-0.02em] text-ink">
          One stream up.
          <GradientText as="span" className="block">
            Four platforms live.
          </GradientText>
        </h2>

        <div className="mt-6 flex items-center gap-3.5" aria-hidden>
          {PLATFORMS.map((p) => (
            <span key={p} style={{ color: PLATFORM_META[p].tint }}>
              <PlatformIcon platform={p} className="h-5 w-5" />
            </span>
          ))}
        </div>
      </div>

      {/* Bottom — rotating blurb */}
      <div className="relative z-10 max-w-md">
        <div className="rounded-2xl border border-line bg-surface/80 p-5">
          <div className="font-display text-sm font-semibold text-ink">{blurb.title}</div>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{blurb.body}</p>
        </div>

        {blurbs.length > 1 && (
          <div className="mt-4 flex gap-1.5" aria-hidden>
            {blurbs.map((_, idx) => (
              <span
                key={idx}
                className={cn(
                  'h-1 rounded-full transition-all duration-300',
                  idx === i ? 'w-6 bg-gradient-brand' : 'w-2 bg-line',
                )}
              />
            ))}
          </div>
        )}
      </div>
    </AuroraBackground>
  )
}
