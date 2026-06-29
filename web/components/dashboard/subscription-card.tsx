'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Separator } from '@/components/ui/separator'
import { formatTokens } from '@/lib/billing'
import { cn } from '@/lib/utils'

export interface SubscriptionState {
  plan: 'payg' | 'subscription'
  subscription_status: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean
  allotment_tokens: number
  purchased_tokens: number
  spendable_tokens: number
  monthly_allotment: number
  allotment_cap: number
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function SubscriptionCard({
  sub,
  subscribing,
  subActionLoading,
  subError,
  onSubscribe,
  onManageBilling,
  onSetCancel,
}: {
  sub: SubscriptionState
  subscribing: boolean
  subActionLoading: boolean
  subError: string | null
  onSubscribe: () => void
  onManageBilling: () => void
  onSetCancel: (cancel: boolean) => void
}) {
  const isSubscriber = sub.plan === 'subscription'

  if (!isSubscriber) {
    return (
      <Card className="border-line">
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-display font-semibold text-ink">SlimCast Pro</div>
              <div className="mt-0.5 text-xs text-ink-faint">Monthly subscription</div>
            </div>
            <div className="font-mono text-2xl font-bold text-ink">
              $20<span className="text-sm font-normal text-ink-faint">/mo</span>
            </div>
          </div>

          <ul className="space-y-1.5 text-sm text-ink-muted">
            <li className="flex items-start gap-2">
              <span className="text-success">✓</span>
              <span>
                {formatTokens(sub.monthly_allotment)} every month — unused tokens roll over, capped at{' '}
                {formatTokens(sub.allotment_cap)}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-success">✓</span>
              <span>Cheaper passthrough — 0.05 tkn/hr (vs 0.1 on pay-as-you-go)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-success">✓</span>
              <span>Top up anytime — purchased tokens stack on your allotment and never expire</span>
            </li>
          </ul>

          {subError && (
            <Alert className="border-warning/40 bg-warning/10">
              <AlertDescription className="text-warning">{subError}</AlertDescription>
            </Alert>
          )}

          <Button onClick={onSubscribe} disabled={subscribing} className="h-9 w-full">
            {subscribing ? 'Redirecting…' : 'Subscribe — $20/mo'}
          </Button>
        </CardContent>
      </Card>
    )
  }

  const status = sub.subscription_status
  const statusClass =
    status === 'active' || status === 'trialing'
      ? 'border-success/40 bg-success/10 text-success'
      : status === 'past_due'
        ? 'border-warning/40 bg-warning/10 text-warning'
        : 'border-line bg-surface-2 text-ink-faint'

  return (
    <Card className="border-line">
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-display font-semibold text-ink">SlimCast Pro</div>
            <div className="mt-0.5 text-xs text-ink-faint">$20/mo subscription</div>
          </div>
          <Badge variant="outline" className={cn(statusClass)}>
            {capitalize((status ?? 'unknown').replace(/_/g, ' '))}
          </Badge>
        </div>

        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Monthly allotment</span>
            <span className="font-mono text-ink">
              {formatTokens(sub.monthly_allotment)}/mo · cap {formatTokens(sub.allotment_cap)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Allotment remaining</span>
            <span className="font-mono text-ink">{formatTokens(sub.allotment_tokens)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">{sub.cancel_at_period_end ? 'Cancels on' : 'Renews on'}</span>
            <span className="font-mono text-ink">{formatDate(sub.current_period_end)}</span>
          </div>
        </div>

        {sub.cancel_at_period_end && (
          <Alert className="border-warning/40 bg-warning/10">
            <AlertDescription className="text-warning">
              Set to cancel on {formatDate(sub.current_period_end)}. You keep your allotment and can keep
              streaming until then.
            </AlertDescription>
          </Alert>
        )}

        {subError && (
          <Alert className="border-warning/40 bg-warning/10">
            <AlertDescription className="text-warning">{subError}</AlertDescription>
          </Alert>
        )}

        <Separator />

        <div className="flex items-center gap-3 text-sm">
          <button
            onClick={onManageBilling}
            disabled={subActionLoading}
            className="text-brand transition-colors hover:text-cyan disabled:opacity-40"
          >
            Manage billing ↗
          </button>
          <span className="text-line-strong">·</span>
          {sub.cancel_at_period_end ? (
            <button
              onClick={() => onSetCancel(false)}
              disabled={subActionLoading}
              className="text-brand transition-colors hover:text-cyan disabled:opacity-40"
            >
              {subActionLoading ? 'Working…' : 'Resume subscription'}
            </button>
          ) : (
            <button
              onClick={() => onSetCancel(true)}
              disabled={subActionLoading}
              className="text-ink-faint transition-colors hover:text-ink disabled:opacity-40"
            >
              {subActionLoading ? 'Working…' : 'Cancel subscription'}
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
