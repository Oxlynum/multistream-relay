'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'
import { PortraitCropEditor } from '@/components/portrait-crop-editor'

interface PlatformSettings {
  platform: string
  bitrate_kbps: number
  fps: number
  orientation: string
  enabled: boolean
}

const PLATFORM_META: Record<string, { label: string; minBitrate: number; maxBitrate: number; supportsPortrait: boolean }> = {
  twitch:   { label: 'Twitch',    minBitrate: 2500, maxBitrate: 8000, supportsPortrait: false },
  kick:     { label: 'Kick',      minBitrate: 2500, maxBitrate: 8000, supportsPortrait: false },
  youtube:  { label: 'YouTube',   minBitrate: 2500, maxBitrate: 9000, supportsPortrait: true  },
  tiktok:   { label: 'TikTok',    minBitrate: 1000, maxBitrate: 4500, supportsPortrait: true  },}

export default function SettingsPage() {
  const router = useRouter()
  const [settings, setSettings] = useState<PlatformSettings[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      const supabase = createBrowserClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data } = await supabase
        .from('platform_connections')
        .select('platform, bitrate_kbps, fps, orientation, enabled')
        .eq('user_id', user.id)
        .order('platform')

      setSettings(data ?? [])
      setLoaded(true)
    }
    load()
  }, [router])

  function update(platform: string, field: string, value: unknown) {
    setSettings(prev => prev.map(s => (s.platform === platform ? { ...s, [field]: value } : s)))
  }

  async function save(platform: string) {
    setSaving(platform)
    const s = settings.find(s => s.platform === platform)
    if (!s) return

    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    await fetch(`/api/platforms/${platform}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bitrate_kbps: s.bitrate_kbps, fps: s.fps, orientation: s.orientation }),
    })

    setSaving(null)
    setSaved(platform)
    setTimeout(() => setSaved(null), 2000)
  }

  if (loaded && settings.length === 0) {
    return (
      <div className="min-h-screen">
        <DashboardNav />
        <div className="max-w-2xl mx-auto px-6 py-16 text-center text-ink-muted">
          <p className="mb-4">No platforms connected yet.</p>
          <a href="/dashboard/platforms" className="text-accent hover:text-accent-strong">Connect platforms →</a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Stream settings</h1>
          <p className="text-sm text-ink-muted mt-1">Tune quality per platform. Changes apply to your next stream.</p>
        </div>

        {settings.some(s => s.orientation === 'portrait' && PLATFORM_META[s.platform]?.supportsPortrait) && (
          <div className="bg-surface border border-line rounded-2xl p-6">
            <div className="mb-4">
              <span className="font-semibold">Vertical framing</span>
              <p className="text-xs text-ink-muted mt-1">
                Your source is 16:9, but portrait platforms need 9:16. Set how the
                vertical crop is framed — it&apos;s cropped once on the GPU and sent to
                every portrait platform.
              </p>
            </div>
            <PortraitCropEditor />
          </div>
        )}

        {settings.map(s => {
          const meta = PLATFORM_META[s.platform]
          if (!meta) return null
          const bitrate = s.bitrate_kbps ?? meta.maxBitrate

          return (
            <div key={s.platform} className="bg-surface border border-line rounded-2xl p-6">
              <div className="flex items-center justify-between mb-5">
                <span className="font-semibold">{meta.label}</span>
                <button
                  onClick={() => save(s.platform)}
                  disabled={saving === s.platform}
                  className="bg-accent hover:bg-accent-strong text-base disabled:opacity-40 px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors min-w-[70px]"
                >
                  {saving === s.platform ? '…' : saved === s.platform ? 'Saved!' : 'Save'}
                </button>
              </div>

              <div className="space-y-5">
                <div>
                  <div className="flex justify-between text-xs text-ink-muted mb-2">
                    <span>Bitrate</span>
                    <span className="font-mono text-ink">{bitrate.toLocaleString()} kbps</span>
                  </div>
                  <input
                    type="range"
                    min={meta.minBitrate}
                    max={meta.maxBitrate}
                    step={250}
                    value={bitrate}
                    onChange={e => update(s.platform, 'bitrate_kbps', parseInt(e.target.value))}
                    className="w-full accent-accent"
                  />
                  <div className="flex justify-between text-xs text-ink-faint mt-1">
                    <span>{meta.minBitrate.toLocaleString()}</span>
                    <span>{meta.maxBitrate.toLocaleString()}</span>
                  </div>
                </div>

                <div>
                  <div className="text-xs text-ink-muted mb-2">Frame rate</div>
                  <div className="flex gap-2">
                    {[60, 30].map(fps => (
                      <button
                        key={fps}
                        onClick={() => update(s.platform, 'fps', fps)}
                        className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${s.fps === fps ? 'bg-accent text-base' : 'bg-base border border-line text-ink-muted hover:text-ink'}`}
                      >
                        {fps} fps
                      </button>
                    ))}
                  </div>
                </div>

                {meta.supportsPortrait && (
                  <div>
                    <div className="text-xs text-ink-muted mb-2">Orientation</div>
                    <div className="flex gap-2">
                      {['landscape', 'portrait'].map(o => (
                        <button
                          key={o}
                          onClick={() => update(s.platform, 'orientation', o)}
                          className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors capitalize ${s.orientation === o ? 'bg-accent text-base' : 'bg-base border border-line text-ink-muted hover:text-ink'}`}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                    {s.orientation === 'portrait' && (
                      <p className="text-xs text-ink-faint mt-2">Portrait adds pillarbox bars to fill the vertical frame.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </main>
    </div>
  )
}
