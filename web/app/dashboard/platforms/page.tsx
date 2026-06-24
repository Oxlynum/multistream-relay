'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
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
  oauth_connected?: boolean
}

// Platforms that support OAuth "Connect" flow
const OAUTH_PLATFORMS = new Set(['twitch', 'youtube', 'facebook'])

const PLATFORMS = [
  { id: 'twitch',   label: 'Twitch',   note: null },
  { id: 'kick',     label: 'Kick',     note: null },
  { id: 'youtube',  label: 'YouTube',  note: null },
  { id: 'tiktok',   label: 'TikTok',   note: 'Requires LIVE access (1000+ followers or manual approval). Portrait mode is enabled automatically.' },
]

function PlatformsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [connections, setConnections] = useState<Record<string, PlatformConfig>>({})
  const [oauthConnected, setOauthConnected] = useState<Record<string, string>>({})
  const [streamKeys, setStreamKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null)

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const loadConnections = useCallback(async (userId: string) => {
    const supabase = createBrowserClient()
    const { data } = await supabase
      .from('platform_connections')
      .select('platform, rtmp_url, bitrate_kbps, fps, orientation, enabled, oauth_connected')
      .eq('user_id', userId)

    const map: Record<string, PlatformConfig> = {}
    for (const row of (data ?? []) as PlatformConfig[]) {
      map[row.platform] = { ...row, connected: true }
    }
    setConnections(map)
  }, [])

  const loadOAuthStatus = useCallback(async (session: { access_token: string }) => {
    const res = await fetch('/api/oauth/status', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    if (res.ok) {
      const { connected } = await res.json()
      setOauthConnected(connected ?? {})
    }
  }, [])

  useEffect(() => {
    async function init() {
      const supabase = createBrowserClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      await Promise.all([
        loadConnections(user.id),
        loadOAuthStatus(session),
      ])

      // Handle OAuth redirect params
      const connected = searchParams.get('connected')
      const oauthError = searchParams.get('oauth_error')
      if (connected) showToast(`${connected.charAt(0).toUpperCase() + connected.slice(1)} connected successfully`)
      if (oauthError) showToast(`Connection failed: ${oauthError}`, 'error')
    }
    init()
  }, [router, searchParams, loadConnections, loadOAuthStatus])

  async function connectOAuth(platformId: string) {
    setConnecting(platformId)
    try {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const res = await fetch(`/api/oauth/${platformId}/authorize`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })

      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: 'Unknown error' }))
        showToast(error ?? 'Failed to start OAuth', 'error')
        return
      }

      const { url } = await res.json()
      window.location.href = url
    } catch {
      showToast('Failed to start OAuth connection', 'error')
      setConnecting(null)
    }
  }

  async function disconnectOAuth(platformId: string) {
    setRemoving(platformId)
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const res = await fetch(`/api/oauth/${platformId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })

    if (!res.ok) {
      showToast('Disconnect failed', 'error')
      setRemoving(null)
      return
    }

    const { data: { user } } = await supabase.auth.getUser()
    if (user) await loadConnections(user.id)
    await loadOAuthStatus(session)
    setRemoving(null)
    showToast(`${platformId} disconnected`)
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

    const { data: { user } } = await supabase.auth.getUser()
    if (user) await loadConnections(user.id)
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

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl text-sm font-medium shadow-lg transition-all ${
          toast.type === 'error'
            ? 'bg-red-900/80 text-red-200 border border-red-700'
            : 'bg-accent/20 text-accent border border-accent/40'
        }`}>
          {toast.msg}
        </div>
      )}

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Platforms</h1>
          <p className="text-sm text-ink-muted mt-1">
            Connect your accounts or paste stream keys. Keys are stored encrypted and never exposed.
          </p>
        </div>

        {PLATFORMS.map(p => {
          const conn = connections[p.id]
          const isConnected = !!conn
          const isOAuthPlatform = OAUTH_PLATFORMS.has(p.id)
          const isOAuthConnected = !!oauthConnected[p.id]

          return (
            <div key={p.id} className="bg-surface border border-line rounded-2xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{p.label}</span>
                  {isConnected && (
                    <span className="text-xs bg-accent-soft/50 text-accent border border-accent/40 px-2 py-0.5 rounded-full">
                      {isOAuthConnected ? 'Connected via OAuth' : 'Connected'}
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
                {/* OAuth connect button */}
                {isOAuthPlatform && (
                  <div>
                    {isOAuthConnected ? (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-ink-muted">
                          Stream key fetched automatically
                        </span>
                        <button
                          onClick={() => disconnectOAuth(p.id)}
                          disabled={removing === p.id}
                          className="text-xs text-red-500 hover:text-red-400 disabled:opacity-40 transition-colors"
                        >
                          {removing === p.id ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => connectOAuth(p.id)}
                        disabled={connecting === p.id}
                        className="w-full bg-accent hover:bg-accent-strong text-base disabled:opacity-40 px-4 py-2.5 rounded-lg text-sm font-semibold transition-colors"
                      >
                        {connecting === p.id ? 'Redirecting…' : `Connect with ${p.label}`}
                      </button>
                    )}
                  </div>
                )}

                {/* Manual key fallback */}
                <div>
                  {isOAuthPlatform && (
                    <label className="text-xs text-ink-faint block mb-1.5">
                      {isOAuthConnected ? 'Or override with a manual stream key' : 'Or paste stream key manually'}
                    </label>
                  )}
                  {!isOAuthPlatform && (
                    <label className="text-xs text-ink-faint block mb-1.5">Stream key</label>
                  )}
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
                      className="bg-surface border border-line hover:border-accent text-ink disabled:opacity-40 px-4 py-2 rounded-lg text-sm font-semibold transition-colors min-w-[70px]"
                    >
                      {saving === p.id ? '…' : saved === p.id ? 'Saved!' : isConnected ? 'Update' : 'Save'}
                    </button>
                  </div>
                </div>

                {/* Manual-only disconnect */}
                {isConnected && !isOAuthConnected && (
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

export default function PlatformsPage() {
  return (
    <Suspense>
      <PlatformsContent />
    </Suspense>
  )
}
