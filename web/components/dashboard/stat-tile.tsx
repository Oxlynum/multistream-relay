import { cn } from '@/lib/utils'

/**
 * Dashboard stat tile — mono label + value. Distinct from the marketing StatTile
 * (no count-up; the period selector refetches these so they swap in place).
 */
export function StatTile({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className={cn('rounded-xl border border-line bg-surface-2 p-4', className)}>
      <div className="font-mono text-xs tracking-wider text-ink-faint uppercase">{label}</div>
      <div className="mt-1.5 font-mono text-2xl font-bold text-ink">{value}</div>
    </div>
  )
}
