'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'
import { BalanceCard } from '@/components/dashboard/balance-card'
import { SubscriptionCard, type SubscriptionState } from '@/components/dashboard/subscription-card'
import { SessionHistory, type StreamSession } from '@/components/dashboard/session-history'
import { AchievementGrid } from '@/components/dashboard/achievement-grid'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { formatTokens } from '@/lib/billing'

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function CreditsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const success = searchParams.get('success') === '1'
  const subscribed = searchParams.get('subscribed') === '1'

  const [token, setToken] = useState<string | null>(null)
  const [balance, setBalance] = useState<number>(0)
  const [sessions, setSessions] = useState<StreamSession[]>([])
  const [earnedKeys, setEarnedKeys] = useState<string[]>([])

  const [sub, setSub] = useState<SubscriptionState | null>(null)
  const [subscribing, setSubscribing] = useState(false)
  const [subActionLoading, setSubActionLoading] = useState(false)
  const [subError, setSubError] = useState<string | null>(null)

  const [buyTokens, setBuyTokens] = useState(10)
  const [checkingOut, setCheckingOut] = useState(false)

  const [refillEnabled, setRefillEnabled] = useState(false)
  const [refillTokens, setRefillTokens] = useState(10)
  const [hasPaymentMethod, setHasPaymentMethod] = useState(false)
  const [card, setCard] = useState<{ brand: string; last4: string } | null>(null)
  const [savingRefill, setSavingRefill] = useState(false)
  const [refillError, setRefillError] = useState<string | null>(null)
  const [portalLoading, setPortalLoading] = useState(false)

  const authHeaders = useCallback(() => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }), [token])

  useEffect(() => {
    async function load() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      setToken(session.access_token)
      const hdrs = { Authorization: `Bearer ${session.access_token}` }

      const [balRes, refillRes, subRes, sessRes, achRes] = await Promise.all([
        fetch('/api/credits/balance', { headers: hdrs }),
        fetch('/api/credits/auto-refill', { headers: hdrs }),
        fetch('/api/subscription', { headers: hdrs }),
        supabase.from('stream_sessions').select('*').eq('user_id', session.user.id).order('started_at', { ascending: false }).limit(20),
        supabase.from('achievements').select('achievement_key').eq('user_id', session.user.id),
      ])

      const bal = await balRes.json().catch(() => ({ tokens: 0 }))
      const refill = await refillRes.json().catch(() => ({ enabled: false, hours: 10, has_payment_method: false, card: null }))
      const subState = subRes.ok ? await subRes.json().catch(() => null) : null

      setBalance(bal.tokens ?? 0)
      setRefillEnabled(refill.enabled)
      setRefillTokens(refill.hours ?? 10)
      setHasPaymentMethod(refill.has_payment_method)
      setCard(refill.card ?? null)
      setSub(subState)
      setSessions(sessRes.data ?? [])
      setEarnedKeys((achRes.data ?? []).map((a: { achievement_key: string }) => a.achievement_key))
    }
    load()
  }, [router, success, subscribed])

  async function checkout() {
    if (!token) return
    setCheckingOut(true)
    const res = await fetch('/api/credits/checkout', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ hours: buyTokens }),  // 1 token == 1 hr in the billing model
    })
    const body = await res.json()
    if (body.url) window.location.href = body.url
    else setCheckingOut(false)
  }

  async function saveRefillSettings(updates: { enabled?: boolean; hours?: number }) {
    if (!token) return
    setSavingRefill(true)
    setRefillError(null)
    const res = await fetch('/api/credits/auto-refill', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(updates),
    })
    const body = await res.json()
    if (!res.ok) {
      if (body.error === 'no_payment_method') {
        setRefillError('Buy tokens once to save a payment method, then enable auto-refill.')
      } else {
        setRefillError(body.message ?? 'Something went wrong.')
      }
    } else {
      if (updates.enabled !== undefined) setRefillEnabled(updates.enabled)
      if (updates.hours !== undefined) setRefillTokens(updates.hours)
    }
    setSavingRefill(false)
  }

  async function openPortal() {
    if (!token) return
    setPortalLoading(true)
    const res = await fetch('/api/stripe/portal', {
      method: 'POST',
      headers: authHeaders(),
    })
    const body = await res.json()
    if (body.url) window.location.href = body.url
    else setPortalLoading(false)
  }

  const refreshSub = useCallback(async () => {
    if (!token) return
    const res = await fetch('/api/subscription', { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) setSub(await res.json().catch(() => null))
  }, [token])

  async function subscribeCheckout() {
    if (!token) return
    setSubscribing(true)
    setSubError(null)
    const res = await fetch('/api/subscription/checkout', {
      method: 'POST',
      headers: authHeaders(),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok && body.url) {
      window.location.href = body.url
      return
    }
    if (res.status === 503 || body.error === 'subscription_not_configured') {
      setSubError('Subscriptions are not available yet.')
    } else if (res.status === 409 || body.error === 'already_subscribed') {
      setSubError('You already have an active subscription.')
      await refreshSub()
    } else {
      setSubError(body.message ?? 'Something went wrong.')
    }
    setSubscribing(false)
  }

  async function manageSubBilling() {
    if (!token) return
    setSubActionLoading(true)
    setSubError(null)
    const res = await fetch('/api/subscription', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ action: 'portal' }),
    })
    const body = await res.json().catch(() => ({}))
    if (body.url) { window.location.href = body.url; return }
    setSubError(body.message ?? body.error ?? 'Could not open billing portal.')
    setSubActionLoading(false)
  }

  async function setSubCancel(cancel: boolean) {
    if (!token) return
    setSubActionLoading(true)
    setSubError(null)
    const res = await fetch('/api/subscription', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ action: cancel ? 'cancel' : 'reactivate' }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) setSubError(body.message ?? body.error ?? 'Something went wrong.')
    await refreshSub()
    setSubActionLoading(false)
  }

  const totalCost = `$${(buyTokens * 2).toFixed(2)}`
  const spendable = sub?.spendable_tokens ?? balance
  const showSplit = !!sub && sub.allotment_tokens > 0

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="mx-auto max-w-2xl space-y-6 px-6 py-10">
        {success && (
          <Alert className="border-success/40 bg-success/10">
            <AlertDescription className="text-success">
              Payment received — tokens added to your balance.
            </AlertDescription>
          </Alert>
        )}

        {subscribed && (
          <Alert className="border-success/40 bg-success/10">
            <AlertDescription className="text-success">
              Subscription active! Your monthly token allotment is on the way.
            </AlertDescription>
          </Alert>
        )}

        {/* Balance */}
        <BalanceCard
          tokens={spendable}
          subtitle={
            showSplit
              ? `${formatTokens(sub!.allotment_tokens)} allotment + ${formatTokens(sub!.purchased_tokens)} purchased`
              : '1 token = $2 · base 1 tkn/hr while live'
          }
        />

        {/* Subscription */}
        {sub && (
          <SubscriptionCard
            sub={sub}
            subscribing={subscribing}
            subActionLoading={subActionLoading}
            subError={subError}
            onSubscribe={subscribeCheckout}
            onManageBilling={manageSubBilling}
            onSetCancel={setSubCancel}
          />
        )}

        {/* Buy tokens */}
        <Card className="border-line">
          <CardContent className="space-y-5 py-1">
            <div className="font-display font-semibold text-ink">Buy tokens</div>

            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink-muted">Tokens to add</span>
                <span className="font-mono text-lg font-bold text-ink">{buyTokens} tkn</span>
              </div>
              <Slider
                min={1}
                max={100}
                value={[buyTokens]}
                onValueChange={(v) => setBuyTokens((v as number[])[0])}
              />
              <div className="flex justify-between text-xs text-ink-faint">
                <span>1 tkn</span>
                <span>100 tkn</span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <div>
                <div className="font-mono text-2xl font-bold text-ink">{totalCost}</div>
                <div className="text-xs text-ink-faint">$2.00 / token · tokens never expire</div>
              </div>
              <Button onClick={checkout} disabled={checkingOut} className="h-9 px-5 font-semibold">
                {checkingOut ? 'Redirecting…' : `Buy ${buyTokens} tkn`}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Auto-refill */}
        <Card className="border-line">
          <CardContent className="space-y-4 py-1">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-display font-semibold text-ink">Auto-refill</div>
                <div className="mt-0.5 text-xs text-ink-faint">
                  Automatically charges your saved card when balance drops below 1 token.
                </div>
              </div>
              <Switch
                checked={refillEnabled}
                disabled={savingRefill}
                onCheckedChange={(checked) => saveRefillSettings({ enabled: checked })}
              />
            </div>

            {refillError && (
              <Alert className="border-warning/40 bg-warning/10">
                <AlertDescription className="text-warning">{refillError}</AlertDescription>
              </Alert>
            )}

            {hasPaymentMethod ? (
              <div className="flex items-center justify-between text-xs">
                {card ? (
                  <span className="text-ink-muted">
                    Charges to <span className="font-medium text-ink">{capitalize(card.brand)} ····{card.last4}</span>
                  </span>
                ) : (
                  <span className="text-ink-muted">Payment method saved</span>
                )}
                <button
                  onClick={openPortal}
                  disabled={portalLoading}
                  className="text-brand transition-colors hover:text-cyan disabled:opacity-40"
                >
                  {portalLoading ? 'Opening…' : 'Manage billing ↗'}
                </button>
              </div>
            ) : (
              <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted">
                Buy tokens once to save your payment method, then enable auto-refill.
              </div>
            )}

            {(refillEnabled || hasPaymentMethod) && (
              <div className="space-y-3 pt-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink-muted">Refill amount</span>
                  <span className="font-mono font-bold text-ink">{refillTokens} tkn · ${(refillTokens * 2).toFixed(2)}</span>
                </div>
                <Slider
                  min={1}
                  max={100}
                  value={[refillTokens]}
                  onValueChange={(v) => setRefillTokens((v as number[])[0])}
                  onValueCommitted={(v) => saveRefillSettings({ hours: (v as number[])[0] })}
                />
                <div className="flex justify-between text-xs text-ink-faint">
                  <span>1 tkn</span>
                  <span>100 tkn</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Achievements */}
        <AchievementGrid earnedKeys={earnedKeys} />

        {/* Stream history */}
        <SessionHistory sessions={sessions} />
      </main>
    </div>
  )
}

export default function CreditsPage() {
  return (
    <Suspense>
      <CreditsPageInner />
    </Suspense>
  )
}
