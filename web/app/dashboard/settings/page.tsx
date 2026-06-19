'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'
import { PortraitCropEditor } from '@/components/portrait-crop-editor'

interface PlatformSettings {
  platform: string
  orientation: string
  enabled: boolean
}

interface EncodeSettings {
  landscape_bitrate_kbps: number
  portrait_bitrate_kbps: number
}

const PLATFORM_META: Record<string, { label: string; supportsPortrait: boolean }> = {
  twitch:   { label: 'Twitch',   supportsPortrait: false },
  kick:     { label: 'Kick',     supportsPortrait: false },
  youtube:  { label: 'YouTube',  supportsPortrait: true  },
  tiktok:   { label: 'TikTok',   supportsPortrait: true  },
}

const LIMITS = {
  landscape: { min: 2500, max: 8000 },
  portrait: { min: 1000, max: 4500 },
}

export default function SettingsPage() {
  const router = useRouter()
  const [settings, setSettings] = useState<PlatformSettings[]>([])
  const [encode, setEncode] = useState<EncodeSettings>({ landscape_bitrate_kbps: 6000, portrait_bitrate_kbps: 4000 })
  const [loaded, setLoaded] = useState(false)
  const [savingEncode, setSavingEncode] = useState(false)
  const [savedEncode, setSavedEncode] = useState(false)
  const [savingOrient, setSavingOrient] = useState<string | null>(null)

  async function authHeader() {
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    return session ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' } : null
  }

  useEffect(() => {
    async function load() {
      const supabase = createBrowserClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data } = await supabase
        .from('platform_connections')
        .select('platform, orientation, enabled')
        .eq('user_id', user.id)
        .order('platform')
      setSettings(data ?? [])

      const headers = await authHeader()
      if (headers) {
        const res = await fetch('/api/encode', { headers })
        if (res.ok) {
          const e = await res.json()
          setEncode({
            landscape_bitrate_kbps: e.landscape_bitrate_kbps,
            portrait_bitrate_kbps: e.portrait_bitrate_kbps,
          })
        }
      }
      setLoaded(true)
    }
    load()
  }, [router])

  async function saveEncode() {
    const headers = await authHeader()
    if (!headers) return
    setSavingEncode(true)
    await fetch('/api/encode', {
      method: 'PATCH',
      headers,
      body: JSON.stringify(encode),
    })
    setSavingEncode(false)
    setSavedEncode(true)
    setTimeout(() => setSavedEncode(false), 2000)
  }

  async function setOrientation(platform: string, orientation: string) {
    setSettings(prev => prev.map(s => (s.platform === platform ? { ...s, orientation } : s)))
    const headers = await authHeader()
    if (!headers) return
    setSavingOrient(platform)
    await fetch(`/api/platforms/${platform}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ orientation }),
    })
    setSavingOrient(null)
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

  const hasPortrait = settings.some(s => s.orientation === 'portrait' && PLATFORM_META[s.platform]?.supportsPortrait)

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Stream settings</h1>
          <p className="text-sm text-ink-muted mt-1">
            Resolution and frame rate come from OBS. Here you set the bitrate cap per
            encode group. Changes apply within ~10s, even mid-stream.
          </p>
        </div>

        {/* Encode-group bitrate caps */}
        <div className="bg-surface border border-line rounded-2xl p-6">
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold">Bitrate caps</span>
            <button
              onClick={saveEncode}
              disabled={savingEncode}
              className="bg-accent hover:bg-accent-strong text-base disabled:opacity-40 px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors min-w-[70px]"
            >
              {savingEncode ? '…' : savedEncode ? 'Saved!' : 'Save'}
            </button>
          </div>
          <p className="text-xs text-ink-faint mb-5">
            Each orientation is encoded once and shared by every platform in it, so
            bitrate is set per group — not per channel.
          </p>

          <div className="space-y-6">
            <BitrateSlider
              label="Landscape encode"
              hint="Twitch · Kick"
              value={encode.landscape_bitrate_kbps}
              min={LIMITS.landscape.min}
              max={LIMITS.landscape.max}
              onChange={v => setEncode(e => ({ ...e, landscape_bitrate_kbps: v }))}
            />
            <BitrateSlider
              label="Portrait encode"
              hint="TikTok · any portrait channel"
              value={encode.portrait_bitrate_kbps}
              min={LIMITS.portrait.min}
              max={LIMITS.portrait.max}
              onChange={v => setEncode(e => ({ ...e, portrait_bitrate_kbps: v }))}
            />
          </div>
        </div>

        {/* Portrait framing */}
        {hasPortrait && (
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

        {/* Per-platform orientation */}
        {settings.filter(s => PLATFORM_META[s.platform]?.supportsPortrait).length > 0 && (
          <div className="bg-surface border border-line rounded-2xl p-6">
            <span className="font-semibold">Orientation</span>
            <p className="text-xs text-ink-faint mb-4 mt-1">
              YouTube and TikTok can join the landscape or the portrait encode group.
            </p>
            <div className="space-y-4">
              {settings.filter(s => PLATFORM_META[s.platform]?.supportsPortrait).map(s => (
                <div key={s.platform} className="flex items-center justify-between">
                  <span className="text-sm">{PLATFORM_META[s.platform].label}</span>
                  <div className="flex gap-2 items-center">
                    {savingOrient === s.platform && <span className="text-xs text-ink-faint">…</span>}
                    {['landscape', 'portrait'].map(o => (
                      <button
                        key={o}
                        onClick={() => setOrientation(s.platform, o)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors capitalize ${s.orientation === o ? 'bg-accent text-base' : 'bg-base border border-line text-ink-muted hover:text-ink'}`}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function BitrateSlider({
  label, hint, value, min, max, onChange,
}: {
  label: string; hint: string; value: number; min: number; max: number; onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="flex justify-between items-baseline mb-2">
        <div>
          <span className="text-sm">{label}</span>
          <span className="text-xs text-ink-faint ml-2">{hint}</span>
        </div>
        <span className="font-mono text-sm text-ink">{value.toLocaleString()} kbps</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={250}
        value={value}
        onChange={e => onChange(parseInt(e.target.value))}
        className="w-full accent-accent"
      />
      <div className="flex justify-between text-xs text-ink-faint mt-1">
        <span>{min.toLocaleString()}</span>
        <span>{max.toLocaleString()}</span>
      </div>
    </div>
  )
}
