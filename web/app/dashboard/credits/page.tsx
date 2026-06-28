'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'
import { formatTokens } from '@/lib/billing'

const ACHIEVEMENTS = [
  { key: 'first_stream',    label: 'First stream',                 reward: '+0.5 tkn' },
  { key: 'streak_7',        label: 'Stream 7 days in a row',       reward: '+1 tkn' },
  { key: 'all_5_platforms', label: 'All 5 platforms live at once', reward: '+1 tkn' },
  { key: 'milestone_30d',   label: '30-day milestone',             reward: '+1 tkn' },
]

interface StreamSession {
  id: string
  started_at: string
  duration_seconds: number | null
  credits_deducted: number | null
  platforms: string[]
}

interface SubscriptionState {
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
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDuration(seconds: number | null) {
  if (!seconds) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

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
  const isSubscriber = sub?.plan === 'subscription'

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-6">
        {success && (
          <div className="bg-accent-soft/40 border border-accent/40 rounded-xl px-5 py-4 text-accent text-sm">
            Payment received — tokens added to your balance.
          </div>
        )}

        {subscribed && (
          <div className="bg-accent-soft/40 border border-accent/40 rounded-xl px-5 py-4 text-accent text-sm">
            Subscription active! Your monthly token allotment is on the way.
          </div>
        )}

        {/* Balance */}
        <div className="bg-surface border border-line rounded-2xl p-6">
          <div className="text-sm text-ink-muted mb-1">Token balance</div>
          <div className="text-4xl font-bold font-mono">{formatTokens(spendable)}</div>
          {showSplit ? (
            <div className="text-xs text-ink-faint mt-1">
              {formatTokens(sub!.allotment_tokens)} allotment + {formatTokens(sub!.purchased_tokens)} purchased
            </div>
          ) : (
            <div className="text-xs text-ink-faint mt-1">1 token = $2 · base 1 tkn/hr while live</div>
          )}
        </div>

        {/* Subscription */}
        {sub && !isSubscriber && (
          <div className="bg-surface border border-line rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">SlimCast Pro</div>
                <div className="text-xs text-ink-faint mt-0.5">Monthly subscription</div>
              </div>
              <div className="text-2xl font-bold font-mono">
                $20<span className="text-sm text-ink-faint font-normal">/mo</span>
              </div>
            </div>

            <ul className="text-sm text-ink-muted space-y-1.5">
              <li className="flex items-start gap-2">
                <span className="text-accent">✓</span>
                <span>{formatTokens(sub.monthly_allotment)} every month — unused tokens roll over, capped at {formatTokens(sub.allotment_cap)}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent">✓</span>
                <span>Cheaper passthrough — 0.05 tkn/hr (vs 0.1 on pay-as-you-go)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-accent">✓</span>
                <span>Top up anytime — purchased tokens stack on your allotment and never expire</span>
              </li>
            </ul>

            {subError && (
              <div className="text-amber-400 text-xs bg-amber-950/20 border border-amber-800/60 rounded-lg px-3 py-2">
                {subError}
              </div>
            )}

            <button
              onClick={subscribeCheckout}
              disabled={subscribing}
              className="w-full bg-accent hover:bg-accent-strong text-base disabled:opacity-40 px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors"
            >
              {subscribing ? 'Redirecting…' : 'Subscribe — $20/mo'}
            </button>
          </div>
        )}

        {sub && isSubscriber && (
          <div className="bg-surface border border-line rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">SlimCast Pro</div>
                <div className="text-xs text-ink-faint mt-0.5">$20/mo subscription</div>
              </div>
              <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                sub.subscription_status === 'active' || sub.subscription_status === 'trialing'
                  ? 'bg-accent-soft/40 text-accent border border-accent/40'
                  : sub.subscription_status === 'past_due'
                  ? 'bg-amber-950/20 text-amber-400 border border-amber-800/60'
                  : 'bg-base text-ink-faint border border-line'
              }`}>
                {capitalize((sub.subscription_status ?? 'unknown').replace(/_/g, ' '))}
              </span>
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Monthly allotment</span>
                <span className="font-mono">{formatTokens(sub.monthly_allotment)}/mo · cap {formatTokens(sub.allotment_cap)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Allotment remaining</span>
                <span className="font-mono">{formatTokens(sub.allotment_tokens)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">{sub.cancel_at_period_end ? 'Cancels on' : 'Renews on'}</span>
                <span className="font-mono">{formatDate(sub.current_period_end)}</span>
              </div>
            </div>

            {sub.cancel_at_period_end && (
              <div className="text-amber-400 text-xs bg-amber-950/20 border border-amber-800/60 rounded-lg px-3 py-2">
                Set to cancel on {formatDate(sub.current_period_end)}. You keep your allotment and can keep streaming until then.
              </div>
            )}

            {subError && (
              <div className="text-amber-400 text-xs bg-amber-950/20 border border-amber-800/60 rounded-lg px-3 py-2">
                {subError}
              </div>
            )}

            <div className="flex items-center gap-3 pt-1 text-sm">
              <button
                onClick={manageSubBilling}
                disabled={subActionLoading}
                className="text-accent hover:text-accent-strong disabled:opacity-40 transition-colors"
              >
                Manage billing ↗
              </button>
              <span className="text-line-strong">·</span>
              {sub.cancel_at_period_end ? (
                <button
                  onClick={() => setSubCancel(false)}
                  disabled={subActionLoading}
                  className="text-accent hover:text-accent-strong disabled:opacity-40 transition-colors"
                >
                  {subActionLoading ? 'Working…' : 'Resume subscription'}
                </button>
              ) : (
                <button
                  onClick={() => setSubCancel(true)}
                  disabled={subActionLoading}
                  className="text-ink-faint hover:text-ink disabled:opacity-40 transition-colors"
                >
                  {subActionLoading ? 'Working…' : 'Cancel subscription'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Buy tokens */}
        <div className="bg-surface border border-line rounded-2xl p-6 space-y-5">
          <div className="font-semibold">Buy tokens</div>

          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-muted">Tokens to add</span>
              <span className="font-mono font-bold text-lg">{buyTokens} tkn</span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={buyTokens}
              onChange={e => setBuyTokens(Number(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-ink-faint">
              <span>1 tkn</span>
              <span>100 tkn</span>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <div>
              <div className="text-2xl font-bold font-mono">{totalCost}</div>
              <div className="text-xs text-ink-faint">$2.00 / token · tokens never expire</div>
            </div>
            <button
              onClick={checkout}
              disabled={checkingOut}
              className="bg-accent hover:bg-accent-strong text-base disabled:opacity-40 px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors"
            >
              {checkingOut ? 'Redirecting…' : `Buy ${buyTokens} tkn`}
            </button>
          </div>
        </div>

        {/* Auto-refill */}
        <div className="bg-surface border border-line rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold">Auto-refill</div>
              <div className="text-xs text-ink-faint mt-0.5">
                Automatically charges your saved card when balance drops below 1 token.
              </div>
            </div>
            <button
              onClick={() => saveRefillSettings({ enabled: !refillEnabled })}
              disabled={savingRefill}
              className={`relative w-11 h-6 rounded-full transition-colors ${refillEnabled ? 'bg-accent' : 'bg-line-strong'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${refillEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>

          {refillError && (
            <div className="text-amber-400 text-xs bg-amber-950/20 border border-amber-800/60 rounded-lg px-3 py-2">
              {refillError}
            </div>
          )}

          {/* Payment method row */}
          {hasPaymentMethod ? (
            <div className="flex items-center justify-between text-xs">
              {card ? (
                <span className="text-ink-muted">
                  Charges to <span className="text-ink font-medium">{capitalize(card.brand)} ····{card.last4}</span>
                </span>
              ) : (
                <span className="text-ink-muted">Payment method saved</span>
              )}
              <button
                onClick={openPortal}
                disabled={portalLoading}
                className="text-accent hover:text-accent-strong disabled:opacity-40 transition-colors"
              >
                {portalLoading ? 'Opening…' : 'Manage billing ↗'}
              </button>
            </div>
          ) : (
            <div className="text-xs text-ink-muted bg-base border border-line rounded-lg px-3 py-2">
              Buy tokens once to save your payment method, then enable auto-refill.
            </div>
          )}

          {(refillEnabled || hasPaymentMethod) && (
            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink-muted">Refill amount</span>
                <span className="font-mono font-bold">{refillTokens} tkn · ${(refillTokens * 2).toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                value={refillTokens}
                onChange={e => setRefillTokens(Number(e.target.value))}
                onMouseUp={e => saveRefillSettings({ hours: Number((e.target as HTMLInputElement).value) })}
                onTouchEnd={e => saveRefillSettings({ hours: Number((e.target as HTMLInputElement).value) })}
                className="w-full accent-accent"
              />
              <div className="flex justify-between text-xs text-ink-faint">
                <span>1 tkn</span>
                <span>100 tkn</span>
              </div>
            </div>
          )}
        </div>

        {/* Achievements */}
        <div>
          <div className="text-sm text-ink-muted mb-3">Achievements</div>
          <div className="space-y-2">
            {ACHIEVEMENTS.map(a => {
              const earned = earnedKeys.includes(a.key)
              return (
                <div
                  key={a.key}
                  className={`flex items-center justify-between rounded-xl px-4 py-3 border ${earned ? 'bg-surface border-line' : 'bg-base border-line/50'}`}
                >
                  <div className="flex items-center gap-3">
                    <span className={`text-lg ${earned ? 'text-accent' : 'text-ink-faint opacity-40'}`}>{earned ? '✓' : '○'}</span>
                    <span className={`text-sm ${earned ? 'text-ink' : 'text-ink-faint'}`}>{a.label}</span>
                  </div>
                  <span className={`text-sm font-mono ${earned ? 'text-accent' : 'text-ink-faint'}`}>{a.reward}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Stream history */}
        {sessions.length > 0 && (
          <div>
            <div className="text-sm text-ink-muted mb-3">Stream history</div>
            <div className="bg-surface border border-line rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-ink-faint text-xs">
                    <th className="text-left px-4 py-3 font-normal">Date</th>
                    <th className="text-left px-4 py-3 font-normal">Duration</th>
                    <th className="text-left px-4 py-3 font-normal">Tokens used</th>
                    <th className="text-left px-4 py-3 font-normal">Platforms</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(s => (
                    <tr key={s.id} className="border-b border-line/50 last:border-0">
                      <td className="px-4 py-3 text-ink-muted">{new Date(s.started_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3 text-ink-muted font-mono">{formatDuration(s.duration_seconds)}</td>
                      <td className="px-4 py-3 text-ink-muted font-mono">{formatTokens(s.credits_deducted ?? 0)}</td>
                      <td className="px-4 py-3 text-ink-faint text-xs capitalize">{s.platforms?.join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
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
