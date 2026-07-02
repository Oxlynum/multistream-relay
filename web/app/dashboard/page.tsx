'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'
import { BalanceCard } from '@/components/dashboard/balance-card'
import { StatTile } from '@/components/dashboard/stat-tile'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTokens } from '@/lib/billing'

interface DashboardData {
  credits: number
  platforms: string[]
}

interface Stats {
  period: string
  credit_balance: number
  total_duration_seconds: number
  total_credits_used: number
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

      const credits = await profileRes.json().catch(() => ({ tokens: 0 }))
      setData({
        credits: credits.tokens ?? 0,
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
        <main className="mx-auto max-w-5xl space-y-5 px-6 py-10">
          <Skeleton className="h-36 w-full rounded-2xl" />
          <Skeleton className="h-48 w-full rounded-2xl" />
        </main>
      </div>
    )
  }

  const credits = data?.credits ?? 0
  const creditsLow = credits < 0.5

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="mx-auto max-w-5xl space-y-5 px-6 py-10">

        <p className="font-pixel text-xs text-brand">PLAYER 1 — READY</p>

        {/* Token balance hero */}
        <BalanceCard
          tokens={credits}
          low={creditsLow}
          subtitle={
            creditsLow
              ? 'Less than 30 minutes remaining'
              : '1 token = $2 · base 1 tkn/hr while live'
          }
          action={
            <Button
              render={<Link href="/dashboard/credits" />}
              size="lg"
              className="h-10 px-5"
            >
              ▶ Insert Coin
            </Button>
          }
        />

        {/* Streaming stats */}
        <Card className="border-line">
          <CardContent className="space-y-5 py-1">
            <div className="flex items-center justify-between gap-3">
              <div className="font-pixel text-[0.6rem] uppercase text-ink-muted">Hi-Scores</div>
              <Tabs value={period} onValueChange={(v) => setPeriod(v as string)}>
                <TabsList>
                  {PERIODS.map(({ value, label }) => (
                    <TabsTrigger key={value} value={value}>{label}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            {statsLoading ? (
              <div className="py-4 text-sm text-ink-faint">Loading…</div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <StatTile label="Hours streamed" value={fmtDuration(stats?.total_duration_seconds ?? 0)} />
                  <StatTile label="Sessions" value={String(stats?.session_count ?? 0)} />
                  <StatTile label="Avg session" value={fmtDuration(stats?.avg_duration_seconds ?? 0)} />
                  <StatTile label="Tokens used" value={formatTokens(stats?.total_credits_used ?? 0)} />
                </div>

                {(stats?.top_platforms?.length ?? 0) > 0 && (
                  <div>
                    <div className="mb-2 text-xs text-ink-faint">Platforms streamed to</div>
                    <div className="flex flex-wrap gap-2">
                      {stats?.top_platforms.map(({ platform, count }) => (
                        <Badge key={platform} variant="outline" className="border-line text-ink-muted">
                          {PLATFORM_LABELS[platform] ?? platform}
                          <span className="ml-1 text-ink-faint">×{count}</span>
                        </Badge>
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
          </CardContent>
        </Card>

        {/* Platforms */}
        <Card className="border-line">
          <CardContent className="space-y-4 py-1">
            <div className="flex items-center justify-between">
              <div className="text-sm text-ink-muted">Platforms</div>
              <Link href="/dashboard/platforms" className="text-xs text-brand transition-colors hover:text-cyan">
                Manage →
              </Link>
            </div>
            {(data?.platforms.length ?? 0) === 0 ? (
              <p className="text-sm text-ink-muted">
                No platforms connected.{' '}
                <Link href="/dashboard/platforms" className="text-brand hover:text-cyan">Add platforms →</Link>
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {data?.platforms.map(p => (
                  <Badge key={p} variant="outline" className="border-line text-ink-muted">
                    {PLATFORM_LABELS[p] ?? p}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

      </main>
    </div>
  )
}
