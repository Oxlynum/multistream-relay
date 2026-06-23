'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'
import { formatTokens } from '@/lib/billing'

interface DashboardData {
  credits_seconds: number
  platforms: string[]
}

interface Stats {
  period: string
  credit_balance_seconds: number
  total_duration_seconds: number
  total_credits_used_seconds: number
  session_count: number
  avg_duration_seconds: number
  top_platforms: Array<{ platform: string; count: number }>
}

const PLATFORM_LABELS: Record<string, string> = {
  twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', tiktok: 'TikTok',
}

function fmtDuration(seconds: number) {
  if (seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

const PERIODS = [
  { value: '7d',  label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
]

export default function DashboardPage() {
  const router = useRouter()
  const [data, setData] = useState<DashboardData | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [period, setPeriod] = useState('30d')
  const [loading, setLoading] = useState(true)
  const [statsLoading, setStatsLoading] = useState(false)

  const load = useCallback(async () => {
    try {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const headers = { Authorization: `Bearer ${session.access_token}` }
      const [profileRes, platformRes] = await Promise.all([
        fetch('/api/credits/balance', { headers }),
        supabase.from('platform_connections').select('platform').eq('user_id', session.user.id),
      ])

      const credits = await profileRes.json().catch(() => ({ seconds: 0 }))
      setData({
        credits_seconds: credits.seconds ?? 0,
        platforms: (platformRes.data ?? []).map((p: { platform: string }) => p.platform),
      })
    } catch (err) {
      console.error('Dashboard load failed:', err)
    } finally {
      setLoading(false)
    }
  }, [router])

  const loadStats = useCallback(async (p: string) => {
    setStatsLoading(true)
    try {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const res = await fetch(`/api/stats?period=${p}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) setStats(await res.json())
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadStats(period) }, [loadStats, period])

  if (loading) {
    return (
      <div className="min-h-screen">
        <DashboardNav />
        <div className="flex items-center justify-center py-32 text-ink-faint text-sm">Loading…</div>
      </div>
    )
  }

  const creditsSeconds = data?.credits_seconds ?? 0
  const creditsLow = creditsSeconds < 1800

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="max-w-5xl mx-auto px-6 py-10 space-y-5">

        {/* Token balance */}
        <div className={`border rounded-2xl p-6 flex items-center justify-between ${creditsLow ? 'bg-amber-950/20 border-amber-800/60' : 'bg-surface border-line'}`}>
          <div>
            <div className="text-sm text-ink-muted mb-1">Token balance</div>
            <div className={`text-3xl font-bold font-mono ${creditsLow ? 'text-amber-400' : 'text-ink'}`}>
              {formatTokens(creditsSeconds)}
            </div>
            <div className="text-xs text-ink-faint mt-1">1 token = $2 · base 1 tkn/hr while live</div>
            {creditsLow && <div className="text-sm text-amber-500 mt-1">Less than 30 minutes remaining</div>}
          </div>
          <a href="/dashboard/credits" className="bg-accent hover:bg-accent-strong text-base px-5 py-2 rounded-lg text-sm font-semibold transition-colors">
            Buy tokens
          </a>
        </div>

        {/* Stats */}
        <div className="bg-surface border border-line rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="text-sm text-ink-muted">Streaming stats</div>
            <div className="flex gap-1 bg-base border border-line rounded-lg p-1">
              {PERIODS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setPeriod(value)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    period === value ? 'bg-elevated text-ink' : 'text-ink-muted hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {statsLoading ? (
            <div className="text-ink-faint text-sm py-4">Loading…</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 mb-5">
                <Stat label="Hours streamed" value={fmtDuration(stats?.total_duration_seconds ?? 0)} />
                <Stat label="Sessions" value={String(stats?.session_count ?? 0)} />
                <Stat label="Avg session" value={fmtDuration(stats?.avg_duration_seconds ?? 0)} />
                <Stat label="Tokens used" value={formatTokens(stats?.total_credits_used_seconds ?? 0)} />
              </div>

              {(stats?.top_platforms?.length ?? 0) > 0 && (
                <div>
                  <div className="text-xs text-ink-faint mb-2">Platforms streamed to</div>
                  <div className="flex flex-wrap gap-2">
                    {stats?.top_platforms.map(({ platform, count }) => (
                      <span key={platform} className="bg-base border border-line text-ink-muted text-xs px-3 py-1 rounded-full">
                        {PLATFORM_LABELS[platform] ?? platform}
                        <span className="text-ink-faint ml-1">×{count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {stats?.session_count === 0 && (
                <p className="text-sm text-ink-faint">
                  No streams yet in this period. Press Go Live in OBS to start.
                </p>
              )}
            </>
          )}
        </div>

        {/* Platforms */}
        <div className="bg-surface border border-line rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm text-ink-muted">Platforms</div>
            <a href="/dashboard/platforms" className="text-xs text-accent hover:text-accent-strong">Manage →</a>
          </div>
          {(data?.platforms.length ?? 0) === 0 ? (
            <p className="text-sm text-ink-muted">
              No platforms connected. <a href="/dashboard/platforms" className="text-accent hover:text-accent-strong">Add platforms →</a>
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data?.platforms.map(p => (
                <span key={p} className="bg-base border border-line text-ink-muted text-sm px-3 py-1 rounded-full">
                  {PLATFORM_LABELS[p] ?? p}
                </span>
              ))}
            </div>
          )}
        </div>

      </main>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-base border border-line rounded-xl p-4">
      <div className="text-xs text-ink-faint mb-1">{label}</div>
      <div className="text-2xl font-bold font-mono text-ink">{value}</div>
    </div>
  )
}
