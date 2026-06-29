import { cn } from '@/lib/utils'

/**
 * Horizontal 5-step progress indicator for the onboarding wizard.
 * Steps up to and including the current `step` index fill with the brand
 * gradient; the active step's label glows.
 */
export function Stepper({ steps, step }: { steps: string[]; step: number }) {
  return (
    <ol className="flex gap-1.5 sm:gap-2">
      {steps.map((label, i) => {
        const filled = i <= step
        const active = i === step
        return (
          <li key={label} className="flex flex-1 flex-col items-center gap-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-500 ease-out',
                  filled ? 'bg-gradient-brand' : 'bg-transparent',
                )}
                style={{ width: filled ? '100%' : '0%' }}
              />
            </div>
            <span
              className={cn(
                'text-center font-mono text-[0.62rem] uppercase tracking-[0.12em] transition-colors sm:text-[0.68rem]',
                active
                  ? 'text-ink [text-shadow:0_0_12px_rgba(124,92,252,0.55)]'
                  : filled
                    ? 'text-ink-muted'
                    : 'text-ink-faint',
              )}
            >
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
