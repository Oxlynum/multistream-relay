import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

type Accent = 'brand' | 'cyan' | 'pink'

const ACCENT_TEXT: Record<Accent, string> = {
  brand: 'text-brand',
  cyan: 'text-cyan',
  pink: 'text-pink',
}

const ACCENT_DOT: Record<Accent, string> = {
  brand: 'bg-brand',
  cyan: 'bg-cyan',
  pink: 'bg-pink',
}

/**
 * Marketing feature card — instrument-panel cadence: a mono index, an accent
 * marker (a bare dot, or a bordered icon-chip when an `icon` is supplied), and a
 * hairline rule that strengthens on hover. Server component; follows the
 * StatTile card convention (plain div, border-line/bg-surface, hover lift).
 */
export function FeatureCard({
  title,
  body,
  index,
  icon,
  accent = 'brand',
  className,
}: {
  title: string
  body: string
  index?: string
  icon?: ReactNode
  accent?: Accent
  className?: string
}) {
  return (
    <div
      className={cn(
        'group rounded-2xl border border-line bg-surface p-6 transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        {icon ? (
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line-strong bg-surface-2 text-ink">
            {icon}
          </span>
        ) : (
          <span
            aria-hidden
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', ACCENT_DOT[accent])}
          />
        )}
        {index ? (
          <span
            aria-hidden
            className={cn('font-mono text-xs font-semibold', ACCENT_TEXT[accent])}
          >
            {index}
          </span>
        ) : null}
      </div>

      <h3 className="mt-4 font-display text-base font-semibold text-ink">{title}</h3>
      <div
        aria-hidden
        className="mt-3 h-px w-full bg-line transition-colors group-hover:bg-line-strong"
      />
      <p className="mt-3 text-sm leading-relaxed text-ink-muted">{body}</p>
    </div>
  )
}
