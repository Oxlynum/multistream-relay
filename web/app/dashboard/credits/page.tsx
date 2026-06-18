'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'

const ACHIEVEMENTS = [
  { key: 'first_stream',    label: 'First stream',                 reward: '+30 min' },
  { key: 'streak_7',        label: 'Stream 7 days in a row',       reward: '+1 hr' },
  { key: 'all_5_platforms', label: 'All 5 platforms live at once', reward: '+1 hr' },
  { key: 'milestone_30d',   label: '30-day milestone',             reward: '+1 hr' },
]

interface StreamSession {
  id: string
  started_at: string
  duration_seconds: number | null
  credits_deducted: number | null
  platforms: string[]
}

function formatDuration(seconds: number | null) {
  if (!seconds) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function CreditsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const success = searchParams.get('success') === '1'

  const [token, setToken] = useState<string | null>(null)
  const [balance, setBalance] = useState<{ seconds: number; formatted: string } | null>(null)
  const [sessions, setSessions] = useState<StreamSession[]>([])
  const [earnedKeys, setEarnedKeys] = useState<string[]>([])

  const [buyHours, setBuyHours] = useState(10)
  const [checkingOut, setCheckingOut] = useState(false)

  const [refillEnabled, setRefillEnabled] = useState(false)
  const [refillHours, setRefillHours] = useState(10)
  const [hasPaymentMethod, setHasPaymentMethod] = useState(false)
  const [savingRefill, setSavingRefill] = useState(false)
  const [refillError, setRefillError] = useState<string | null>(null)

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

      const [balRes, refillRes, sessRes, achRes] = await Promise.all([
        fetch('/api/credits/balance', { headers: hdrs }),
        fetch('/api/credits/auto-refill', { headers: hdrs }),
        supabase.from('stream_sessions').select('*').eq('user_id', session.user.id).order('started_at', { ascending: false }).limit(20),
        supabase.from('achievements').select('achievement_key').eq('user_id', session.user.id),
      ])

      const bal = await balRes.json().catch(() => ({ seconds: 0, formatted: '0m' }))
      const refill = await refillRes.json().catch(() => ({ enabled: false, hours: 10, has_payment_method: false }))

      setBalance({ seconds: bal.seconds, formatted: bal.formatted })
      setRefillEnabled(refill.enabled)
      setRefillHours(refill.hours)
      setHasPaymentMethod(refill.has_payment_method)
      setSessions(sessRes.data ?? [])
      setEarnedKeys((achRes.data ?? []).map((a: { achievement_key: string }) => a.achievement_key))
    }
    load()
  }, [router, success])

  async function checkout() {
    if (!token) return
    setCheckingOut(true)
    const res = await fetch('/api/credits/checkout', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ hours: buyHours }),
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
        setRefillError('Buy credits once to save a payment method, then enable auto-refill.')
      } else {
        setRefillError(body.message ?? 'Something went wrong.')
      }
    } else {
      if (updates.enabled !== undefined) setRefillEnabled(updates.enabled)
      if (updates.hours !== undefined) setRefillHours(updates.hours)
    }
    setSavingRefill(false)
  }

  const totalCost = `$${(buyHours * 2).toFixed(2)}`

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-6">
        {success && (
          <div className="bg-accent-soft/40 border border-accent/40 rounded-xl px-5 py-4 text-accent text-sm">
            Payment received — credits added to your balance.
          </div>
        )}

        {/* Balance */}
        <div className="bg-surface border border-line rounded-2xl p-6">
          <div className="text-sm text-ink-muted mb-1">Current balance</div>
          <div className="text-4xl font-bold font-mono">{balance?.formatted ?? '—'}</div>
          <div className="text-xs text-ink-faint mt-1">of streaming time remaining</div>
        </div>

        {/* Buy credits */}
        <div className="bg-surface border border-line rounded-2xl p-6 space-y-5">
          <div className="font-semibold">Buy streaming time</div>

          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-muted">Hours to add</span>
              <span className="font-mono font-bold text-lg">{buyHours} hr{buyHours !== 1 ? 's' : ''}</span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={buyHours}
              onChange={e => setBuyHours(Number(e.target.value))}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-ink-faint">
              <span>1 hr</span>
              <span>100 hrs</span>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <div>
              <div className="text-2xl font-bold font-mono">{totalCost}</div>
              <div className="text-xs text-ink-faint">$2.00 / hr · credits never expire</div>
            </div>
            <button
              onClick={checkout}
              disabled={checkingOut}
              className="bg-accent hover:bg-accent-strong text-base disabled:opacity-40 px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors"
            >
              {checkingOut ? 'Redirecting…' : `Buy ${buyHours} hr${buyHours !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>

        {/* Auto-refill */}
        <div className="bg-surface border border-line rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold">Auto-refill</div>
              <div className="text-xs text-ink-faint mt-0.5">
                Automatically buys more time when your balance drops below 1 hour.
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

          {!hasPaymentMethod && (
            <div className="text-xs text-ink-muted bg-base border border-line rounded-lg px-3 py-2">
              Buy credits once to save your payment method, then enable auto-refill.
            </div>
          )}

          {(refillEnabled || hasPaymentMethod) && (
            <div className="space-y-3 pt-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink-muted">Refill amount</span>
                <span className="font-mono font-bold">{refillHours} hr{refillHours !== 1 ? 's' : ''} · ${(refillHours * 2).toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                value={refillHours}
                onChange={e => setRefillHours(Number(e.target.value))}
                onMouseUp={e => saveRefillSettings({ hours: Number((e.target as HTMLInputElement).value) })}
                onTouchEnd={e => saveRefillSettings({ hours: Number((e.target as HTMLInputElement).value) })}
                className="w-full accent-accent"
              />
              <div className="flex justify-between text-xs text-ink-faint">
                <span>1 hr</span>
                <span>100 hrs</span>
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

        {/* History */}
        {sessions.length > 0 && (
          <div>
            <div className="text-sm text-ink-muted mb-3">Stream history</div>
            <div className="bg-surface border border-line rounded-2xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-ink-faint text-xs">
                    <th className="text-left px-4 py-3 font-normal">Date</th>
                    <th className="text-left px-4 py-3 font-normal">Duration</th>
                    <th className="text-left px-4 py-3 font-normal">Credits used</th>
                    <th className="text-left px-4 py-3 font-normal">Platforms</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map(s => (
                    <tr key={s.id} className="border-b border-line/50 last:border-0">
                      <td className="px-4 py-3 text-ink-muted">{new Date(s.started_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3 text-ink-muted font-mono">{formatDuration(s.duration_seconds)}</td>
                      <td className="px-4 py-3 text-ink-muted font-mono">{formatDuration(s.credits_deducted)}</td>
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
