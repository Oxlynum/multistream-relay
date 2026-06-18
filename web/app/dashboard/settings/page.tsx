'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

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
  youtube:  { label: 'YouTube',   minBitrate: 2500, maxBitrate: 9000, supportsPortrait: false },
  tiktok:   { label: 'TikTok',    minBitrate: 1000, maxBitrate: 4500, supportsPortrait: true  },
  facebook: { label: 'Facebook',  minBitrate: 1000, maxBitrate: 4000, supportsPortrait: true  },
}

export default function SettingsPage() {
  const router = useRouter()
  const [settings, setSettings] = useState<PlatformSettings[]>([])
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
    }
    load()
  }, [router])

  function update(platform: string, field: string, value: unknown) {
    setSettings(prev => prev.map(s =>
      s.platform === platform ? { ...s, [field]: value } : s
    ))
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
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bitrate_kbps: s.bitrate_kbps,
        fps: s.fps,
        orientation: s.orientation,
      }),
    })

    setSaving(null)
    setSaved(platform)
    setTimeout(() => setSaved(null), 2000)
  }

  if (settings.length === 0) {
    return (
      <main className="min-h-screen bg-gray-950 text-white">
        <nav className="flex items-center gap-4 px-8 py-5 border-b border-gray-800">
          <a href="/dashboard" className="text-gray-400 hover:text-white transition-colors text-sm">← Dashboard</a>
          <span className="text-xl font-bold tracking-tight">Settings</span>
        </nav>
        <div className="max-w-2xl mx-auto px-6 py-16 text-center text-gray-500">
          <p className="mb-4">No platforms connected yet.</p>
          <a href="/dashboard/platforms" className="text-blue-400 hover:text-blue-300">Connect platforms →</a>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center gap-4 px-8 py-5 border-b border-gray-800">
        <a href="/dashboard" className="text-gray-400 hover:text-white transition-colors text-sm">← Dashboard</a>
        <span className="text-xl font-bold tracking-tight">Settings</span>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-10 space-y-4">
        {settings.map(s => {
          const meta = PLATFORM_META[s.platform]
          if (!meta) return null
          const bitrate = s.bitrate_kbps ?? meta.maxBitrate

          return (
            <div key={s.platform} className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-5">
                <span className="font-semibold">{meta.label}</span>
                <button
                  onClick={() => save(s.platform)}
                  disabled={saving === s.platform}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors min-w-[70px]"
                >
                  {saving === s.platform ? '…' : saved === s.platform ? 'Saved!' : 'Save'}
                </button>
              </div>

              <div className="space-y-5">
                {/* Bitrate */}
                <div>
                  <div className="flex justify-between text-xs text-gray-400 mb-2">
                    <span>Bitrate</span>
                    <span className="font-mono">{bitrate.toLocaleString()} kbps</span>
                  </div>
                  <input
                    type="range"
                    min={meta.minBitrate}
                    max={meta.maxBitrate}
                    step={250}
                    value={bitrate}
                    onChange={e => update(s.platform, 'bitrate_kbps', parseInt(e.target.value))}
                    className="w-full accent-blue-500"
                  />
                  <div className="flex justify-between text-xs text-gray-600 mt-1">
                    <span>{meta.minBitrate.toLocaleString()} kbps</span>
                    <span>{meta.maxBitrate.toLocaleString()} kbps</span>
                  </div>
                </div>

                {/* FPS */}
                <div>
                  <div className="text-xs text-gray-400 mb-2">Frame rate</div>
                  <div className="flex gap-2">
                    {[60, 30].map(fps => (
                      <button
                        key={fps}
                        onClick={() => update(s.platform, 'fps', fps)}
                        className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${s.fps === fps ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                      >
                        {fps} fps
                      </button>
                    ))}
                  </div>
                </div>

                {/* Orientation (only for platforms that support portrait) */}
                {meta.supportsPortrait && (
                  <div>
                    <div className="text-xs text-gray-400 mb-2">Orientation</div>
                    <div className="flex gap-2">
                      {['landscape', 'portrait'].map(o => (
                        <button
                          key={o}
                          onClick={() => update(s.platform, 'orientation', o)}
                          className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors capitalize ${s.orientation === o ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                    {s.orientation === 'portrait' && (
                      <p className="text-xs text-gray-500 mt-2">Portrait adds pillarbox bars to fill the vertical frame.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </main>
  )
}
