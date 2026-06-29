import type { ReactNode } from 'react'

import { Kicker } from '@/components/ui/kicker'
import { cn } from '@/lib/utils'

type Accent = 'brand' | 'cyan' | 'pink'

function Check() {
  return (
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
  )
}

/**
 * Zig-zag feature section — prose on one side (Kicker + heading + body), a
 * `surface` card with a check-bulleted list on the other. `reversed` flips the
 * column order; `glow` adds an aurora edge-glow + brand-tinted border to the
 * card. Server component; mirrors the landing card conventions.
 */
export function FeatureSplit({
  kicker,
  kickerColor = 'brand',
  title,
  body,
  points,
  reversed = false,
  glow = false,
  className,
}: {
  kicker: string
  kickerColor?: Accent
  title: ReactNode
  body: string
  points: string[]
  reversed?: boolean
  glow?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid items-center gap-10 lg:grid-cols-2 lg:gap-16',
        className,
      )}
    >
      {/* Prose */}
      <div className={cn(reversed && 'lg:order-2')}>
        <Kicker color={kickerColor}>{kicker}</Kicker>
        <h2 className="mt-4 font-display text-[clamp(1.75rem,3vw,2.5rem)] font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h2>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-muted">{body}</p>
      </div>

      {/* Check-list card */}
      <div className={cn('relative', reversed && 'lg:order-1')}>
        {glow ? (
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-3 -z-10 bg-gradient-brand opacity-15 blur-2xl"
          />
        ) : null}
        <div
          className={cn(
            'rounded-2xl border bg-surface p-7 md:p-8',
            glow ? 'border-brand/30 shadow-glow' : 'border-line',
          )}
        >
          <ul className="space-y-4">
            {points.map((p) => (
              <li key={p} className="flex items-start gap-3">
                <Check />
                <span className="text-sm leading-relaxed text-ink-muted">{p}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
