import type { ReactNode } from 'react'
import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

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

/**
 * Two-tier token plan card. `featured` lights it with `shadow-glow`, a
 * brand-tinted border, and a floating "Best for regulars" `Badge`; a
 * non-featured card can surface a `badge` (e.g. "2 free tokens on signup")
 * inline. Server component.
 */
export function PricingCard({
  name,
  price,
  unit,
  blurb,
  features,
  ctaHref,
  ctaLabel,
  featured = false,
  badge,
  className,
}: {
  name: string
  price: string
  unit?: string
  blurb: ReactNode
  features: string[]
  ctaHref: string
  ctaLabel: string
  featured?: boolean
  badge?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl border bg-surface p-7 md:p-8',
        featured ? 'border-brand/40 shadow-glow' : 'border-line',
        className,
      )}
    >
      {featured ? (
        <Badge className="absolute -top-2.5 left-7">{badge ?? 'Best for regulars'}</Badge>
      ) : null}

      <h3 className="font-display text-xl font-semibold text-ink">{name}</h3>

      <div className="mt-4 flex items-baseline gap-1.5">
        <span className="font-mono text-4xl font-semibold tracking-tight text-ink">{price}</span>
        {unit ? <span className="text-sm text-ink-muted">{unit}</span> : null}
      </div>

      <p className="mt-3 text-sm leading-relaxed text-ink-muted">{blurb}</p>

      {!featured && badge ? (
        <Badge variant="secondary" className="mt-4 w-fit">
          {badge}
        </Badge>
      ) : null}

      <ul className="mt-6 space-y-3 border-t border-line pt-6">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2.5">
            <Check />
            <span className="text-sm leading-relaxed text-ink-muted">{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-8">
        <Link
          href={ctaHref}
          className={cn(
            buttonVariants({ variant: featured ? 'default' : 'outline' }),
            'h-12 w-full rounded-xl text-base font-semibold',
            featured && 'shadow-glow',
          )}
        >
          {ctaLabel}
        </Link>
      </div>
    </div>
  )
}
