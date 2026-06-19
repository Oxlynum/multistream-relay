'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'

interface PlatformConfig {
  platform: string
  rtmp_url: string
  bitrate_kbps: number | null
  fps: number
  orientation: string
  enabled: boolean
  connected: boolean
}

const PLATFORMS = [
  { id: 'twitch',   label: 'Twitch',   note: null },
  { id: 'kick',     label: 'Kick',     note: null },
  { id: 'youtube',  label: 'YouTube',  note: null },
  { id: 'tiktok',   label: 'TikTok',   note: 'Requires LIVE access (1000+ followers or manual approval). Portrait mode is enabled automatically.' },]

export default function PlatformsPage() {
  const router = useRouter()
  const [connections, setConnections] = useState<Record<string, PlatformConfig>>({})
  const [streamKeys, setStreamKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const supabase = createBrowserClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data } = await supabase
        .from('platform_connections')
        .select('platform, rtmp_url, bitrate_kbps, fps, orientation, enabled')
        .eq('user_id', user.id)

      const map: Record<string, PlatformConfig> = {}
      for (const row of (data ?? []) as PlatformConfig[]) {
        map[row.platform] = { ...row, connected: true }
      }
      setConnections(map)
    }
    load()
  }, [router])

  async function refreshConnections(userId: string) {
    const supabase = createBrowserClient()
    const { data } = await supabase
      .from('platform_connections')
      .select('platform, rtmp_url, bitrate_kbps, fps, orientation, enabled')
      .eq('user_id', userId)
    const map: Record<string, PlatformConfig> = {}
    for (const row of (data ?? []) as PlatformConfig[]) {
      map[row.platform] = { ...row, connected: true }
    }
    setConnections(map)
  }

  async function save(platformId: string) {
    const key = streamKeys[platformId]?.trim()
    if (!key) return

    setSaving(platformId)
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    await fetch('/api/platforms', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: platformId, stream_key: key }),
    })

    await refreshConnections(session.user.id)
    setStreamKeys(prev => ({ ...prev, [platformId]: '' }))
    setSaving(null)
    setSaved(platformId)
    setTimeout(() => setSaved(null), 2000)
  }

  async function remove(platformId: string) {
    setRemoving(platformId)
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    await fetch(`/api/platforms/${platformId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })

    setConnections(prev => {
      const next = { ...prev }
      delete next[platformId]
      return next
    })
    setRemoving(null)
  }

  async function toggleEnabled(platformId: string, enabled: boolean) {
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    await fetch(`/api/platforms/${platformId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })

    setConnections(prev => ({ ...prev, [platformId]: { ...prev[platformId], enabled } }))
  }

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Platforms</h1>
          <p className="text-sm text-ink-muted mt-1">
            Paste your stream keys here. They&apos;re stored encrypted and streamed automatically when you go live.
          </p>
        </div>

        {PLATFORMS.map(p => {
          const conn = connections[p.id]
          const isConnected = !!conn

          return (
            <div key={p.id} className="bg-surface border border-line rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{p.label}</span>
                  {isConnected && (
                    <span className="text-xs bg-accent-soft/50 text-accent border border-accent/40 px-2 py-0.5 rounded-full">
                      Connected
                    </span>
                  )}
                </div>
                {isConnected && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <span className="text-xs text-ink-muted">Active</span>
                    <button
                      onClick={() => toggleEnabled(p.id, !conn.enabled)}
                      className={`relative w-9 h-5 rounded-full transition-colors ${conn.enabled ? 'bg-accent' : 'bg-line-strong'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${conn.enabled ? 'translate-x-4' : ''}`} />
                    </button>
                  </label>
                )}
              </div>

              {p.note && <p className="text-xs text-ink-faint mb-4 leading-relaxed">{p.note}</p>}

              <div className="space-y-3">
                <div>
                  <label className="text-xs text-ink-faint block mb-1.5">Stream key</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      placeholder={isConnected ? '••••••••••••••••' : 'Paste your stream key'}
                      value={streamKeys[p.id] ?? ''}
                      onChange={e => setStreamKeys(prev => ({ ...prev, [p.id]: e.target.value }))}
                      className="flex-1 bg-base border border-line rounded-lg px-3 py-2 text-sm placeholder-ink-faint focus:outline-none focus:border-accent transition-colors"
                    />
                    <button
                      onClick={() => save(p.id)}
                      disabled={saving === p.id || !streamKeys[p.id]?.trim()}
                      className="bg-accent hover:bg-accent-strong text-base disabled:opacity-40 px-4 py-2 rounded-lg text-sm font-semibold transition-colors min-w-[70px]"
                    >
                      {saving === p.id ? '…' : saved === p.id ? 'Saved!' : isConnected ? 'Update' : 'Save'}
                    </button>
                  </div>
                </div>

                {isConnected && (
                  <button
                    onClick={() => remove(p.id)}
                    disabled={removing === p.id}
                    className="text-xs text-red-500 hover:text-red-400 disabled:opacity-40 transition-colors"
                  >
                    {removing === p.id ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </main>
    </div>
  )
}
