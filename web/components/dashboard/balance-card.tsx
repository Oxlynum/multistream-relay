import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { formatTokens } from '@/lib/billing'

/**
 * Token-balance hero. Big aurora mono number when healthy; amber when low.
 * Used by the Overview hero and the Credits balance section.
 */
export function BalanceCard({
  tokens,
  low = false,
  subtitle,
  action,
  className,
}: {
  tokens: number
  low?: boolean
  subtitle?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-2xl border p-6 sm:p-8',
        low ? 'border-warning/40 bg-warning/5' : 'border-line bg-surface',
        className,
      )}
    >
      {!low && (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full bg-gradient-brand opacity-20 blur-3xl"
        />
      )}
      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="font-mono text-xs font-semibold tracking-[0.2em] text-ink-faint uppercase">
            Token balance
          </div>
          <div
            className={cn(
              'mt-2 font-mono text-4xl font-bold sm:text-5xl',
              low ? 'text-warning' : 'text-aurora',
            )}
          >
            {formatTokens(tokens)}
          </div>
          {subtitle && <div className="mt-2 text-sm text-ink-muted">{subtitle}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  )
}
