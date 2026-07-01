'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'
import { Kicker } from '@/components/ui/kicker'
import { PlatformConnectCard } from '@/components/dashboard/platform-connect-card'
import type { PlatformKey } from '@/components/platform-icon'

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
const OAUTH_PLATFORMS = new Set(['twitch', 'youtube', 'kick', 'facebook'])

const PLATFORMS: Array<{ id: PlatformKey; label: string; note: string | null }> = [
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
      if (connected) toast.success(`${connected.charAt(0).toUpperCase() + connected.slice(1)} connected successfully`)
      if (oauthError) toast.error(`Connection failed: ${oauthError}`)
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
        toast.error(error ?? 'Failed to start OAuth')
        return
      }

      const { url } = await res.json()
      window.location.href = url
    } catch {
      toast.error('Failed to start OAuth connection')
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
      toast.error('Disconnect failed')
      setRemoving(null)
      return
    }

    const { data: { user } } = await supabase.auth.getUser()
    if (user) await loadConnections(user.id)
    await loadOAuthStatus(session)
    setRemoving(null)
    toast.success(`${platformId} disconnected`)
  }

  async function save(platformId: string) {
    const key = streamKeys[platformId]?.trim()
    if (!key) return

    setSaving(platformId)
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setSaving(null); router.push('/login'); return }

    let res: Response
    try {
      res = await fetch('/api/platforms', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: platformId, stream_key: key }),
      })
    } catch {
      setSaving(null)
      toast.error('Network error — stream key not saved')
      return
    }

    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: null }))
      setSaving(null)
      toast.error(error ?? 'Failed to save stream key')
      return
    }

    const { data: { user } } = await supabase.auth.getUser()
    if (user) await loadConnections(user.id)
    setStreamKeys(prev => ({ ...prev, [platformId]: '' }))
    setSaving(null)
    setSaved(platformId)
    toast.success('Stream key saved')
    setTimeout(() => setSaved(null), 2000)
  }

  async function remove(platformId: string) {
    setRemoving(platformId)
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setRemoving(null); return }

    const res = await fetch(`/api/platforms/${platformId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` },
    }).catch(() => null)

    if (!res?.ok) {
      setRemoving(null)
      toast.error('Failed to remove platform')
      return
    }

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

    const res = await fetch(`/api/platforms/${platformId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => null)

    if (!res?.ok) {
      toast.error('Failed to update — try again')
      return
    }

    setConnections(prev => ({ ...prev, [platformId]: { ...prev[platformId], enabled } }))
  }

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="mx-auto max-w-2xl space-y-4 px-6 py-10">
        <div>
          <Kicker color="pink">Destinations</Kicker>
          <h1 className="mt-3 font-display text-2xl font-semibold text-ink">Platforms</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Connect your accounts or paste stream keys. Keys are stored encrypted and never exposed.
          </p>
        </div>

        {PLATFORMS.map(p => {
          const conn = connections[p.id]
          const isConnected = !!conn
          const isOAuthPlatform = OAUTH_PLATFORMS.has(p.id)
          const isOAuthConnected = !!oauthConnected[p.id]

          return (
            <PlatformConnectCard
              key={p.id}
              id={p.id}
              label={p.label}
              note={p.note}
              connected={isConnected}
              enabled={!!conn?.enabled}
              isOAuthPlatform={isOAuthPlatform}
              isOAuthConnected={isOAuthConnected}
              streamKey={streamKeys[p.id] ?? ''}
              connecting={connecting === p.id}
              saving={saving === p.id}
              saved={saved === p.id}
              removing={removing === p.id}
              onStreamKeyChange={(v) => setStreamKeys(prev => ({ ...prev, [p.id]: v }))}
              onToggleEnabled={(enabled) => toggleEnabled(p.id, enabled)}
              onConnectOAuth={() => connectOAuth(p.id)}
              onDisconnectOAuth={() => disconnectOAuth(p.id)}
              onSave={() => save(p.id)}
              onRemove={() => remove(p.id)}
            />
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
