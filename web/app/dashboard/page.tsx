'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

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
  twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook',
}

function fmt(seconds: number) {
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
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const token = session.access_token
      const headers = { Authorization: `Bearer ${token}` }

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

  async function generateApiKey() {
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    const res = await fetch('/api/apikey', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    const body = await res.json()
    setApiKey(body.api_key)
    await load()
  }

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  async function signOut() {
    const supabase = createBrowserClient()
    await supabase.auth.signOut()
    router.push('/')
  }

  if (loading) {
    return <main className="min-h-screen bg-gray-950 text-white flex items-center justify-center text-gray-500">Loading…</main>
  }

  const creditsLow = (data?.credits_seconds ?? 0) < 1800

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-8 py-5 border-b border-gray-800">
        <span className="text-xl font-bold tracking-tight">SlimCast</span>
        <div className="flex items-center gap-6 text-sm">
          <a href="/dashboard/platforms" className="text-gray-400 hover:text-white transition-colors">Platforms</a>
          <a href="/dashboard/settings" className="text-gray-400 hover:text-white transition-colors">Settings</a>
          <a href="/dashboard/credits" className="text-gray-400 hover:text-white transition-colors">Credits</a>
          <button onClick={signOut} className="text-gray-400 hover:text-white transition-colors">Sign out</button>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-6 py-10 space-y-5">

        {/* Credits */}
        <div className={`border rounded-2xl p-6 flex items-center justify-between ${creditsLow ? 'bg-amber-950/30 border-amber-800' : 'bg-gray-900 border-gray-800'}`}>
          <div>
            <div className="text-sm text-gray-400 mb-1">Streaming credits</div>
            <div className={`text-3xl font-bold ${creditsLow ? 'text-amber-400' : 'text-white'}`}>
              {fmt(data?.credits_seconds ?? 0)}
            </div>
            {creditsLow && <div className="text-sm text-amber-500 mt-1">Less than 30 minutes remaining</div>}
          </div>
          <a href="/dashboard/credits" className="bg-blue-600 hover:bg-blue-500 px-5 py-2 rounded-lg text-sm font-semibold transition-colors">
            Buy Credits
          </a>
        </div>

        {/* Stats */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="text-sm text-gray-400">Streaming stats</div>
            <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
              {PERIODS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setPeriod(value)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    period === value
                      ? 'bg-gray-600 text-white'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {statsLoading ? (
            <div className="text-gray-600 text-sm">Loading…</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 mb-5">
                <Stat
                  label="Hours streamed"
                  value={fmt(stats?.total_duration_seconds ?? 0)}
                />
                <Stat
                  label="Sessions"
                  value={String(stats?.session_count ?? 0)}
                />
                <Stat
                  label="Avg session"
                  value={fmt(stats?.avg_duration_seconds ?? 0)}
                />
                <Stat
                  label="Credits used"
                  value={fmt(stats?.total_credits_used_seconds ?? 0)}
                />
              </div>

              {(stats?.top_platforms?.length ?? 0) > 0 && (
                <div>
                  <div className="text-xs text-gray-500 mb-2">Platforms streamed to</div>
                  <div className="flex flex-wrap gap-2">
                    {stats?.top_platforms.map(({ platform, count }) => (
                      <span
                        key={platform}
                        className="bg-gray-800 text-gray-300 text-xs px-3 py-1 rounded-full"
                      >
                        {PLATFORM_LABELS[platform] ?? platform}
                        <span className="text-gray-500 ml-1">×{count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {stats?.session_count === 0 && (
                <p className="text-sm text-gray-600">
                  No streams yet in this period. Start streaming in OBS to see your stats here.
                </p>
              )}
            </>
          )}
        </div>

        {/* Platforms connected */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm text-gray-400">Platforms</div>
            <a href="/dashboard/platforms" className="text-xs text-blue-400 hover:text-blue-300">Manage →</a>
          </div>
          {(data?.platforms.length ?? 0) === 0 ? (
            <p className="text-sm text-gray-500">
              No platforms connected. <a href="/dashboard/platforms" className="text-blue-400 hover:text-blue-300">Add platforms →</a>
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {data?.platforms.map(p => (
                <span key={p} className="bg-gray-800 text-gray-300 text-sm px-3 py-1 rounded-full">
                  {PLATFORM_LABELS[p] ?? p}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* API Key */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="text-sm text-gray-400 mb-1">OBS API key</div>
          <div className="text-xs text-gray-500 mb-4">
            Paste this into the SlimCast panel inside OBS. Refreshing creates a new key and invalidates the old one.
          </div>
          {apiKey ? (
            <div className="space-y-3">
              <div className="bg-amber-950/40 border border-amber-800 rounded-lg px-3 py-2 text-xs text-amber-400">
                Copy this now — it won&apos;t be shown again.
              </div>
              <div className="flex items-center gap-3">
                <code className="flex-1 bg-gray-800 rounded-lg px-3 py-2 text-sm font-mono text-gray-300 break-all">
                  {apiKey}
                </code>
                <button
                  onClick={() => copy(apiKey, 'apikey')}
                  className={`px-3 py-2 rounded-lg text-sm transition-colors min-w-[70px] ${copied === 'apikey' ? 'bg-green-700 text-white' : 'bg-gray-700 hover:bg-gray-600'}`}
                >
                  {copied === 'apikey' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={generateApiKey}
              className="bg-gray-700 hover:bg-gray-600 px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
            >
              Refresh API key
            </button>
          )}
        </div>

      </div>
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-800/60 rounded-xl p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-2xl font-bold text-white">{value}</div>
    </div>
  )
}
