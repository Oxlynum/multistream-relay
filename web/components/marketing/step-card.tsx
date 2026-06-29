import { cn } from '@/lib/utils'

/**
 * How-it-works step card — a big aurora "ghost" number bleeding off the corner
 * paired with a mono "Step 0X / 04" index. Server component; StatTile card
 * convention (plain div, border-line/bg-surface, hover lift).
 */
export function StepCard({
  n,
  title,
  body,
  className,
}: {
  n: string
  title: string
  body: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl border border-line bg-surface p-7 transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md',
        className,
      )}
    >
      <span
        aria-hidden
        className="text-aurora pointer-events-none absolute -top-5 -right-3 select-none font-mono text-8xl leading-none font-bold opacity-15"
      >
        {n}
      </span>
      <div className="relative">
        <div className="font-mono text-xs font-semibold tracking-[0.15em] text-brand">
          Step {n} / 04
        </div>
        <h3 className="mt-4 font-display text-lg font-semibold text-ink">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">{body}</p>
      </div>
    </div>
  )
}
