'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'
import { PortraitCropEditor } from '@/components/portrait-crop-editor'
import { formatTokens, formatDuration, secondsRemaining, type OutputSettingsMap, type OutputSettings } from '@/lib/billing'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlatformConfig {
  platform: string
  orientation: string
  enabled: boolean
  // Twitch-only HEVC/Enhanced-Broadcasting eligibility (null/false for others).
  twitch_hevc_eligible?: boolean | null
  twitch_use_passthrough?: boolean | null
  twitch_max_height?: number | null
}

interface PricingBreakdown {
  line_items: Array<{ platform: string; label: string; detail: string; tokens_per_hr: number }>
  total_tokens_per_hr: number
  total_dollars_per_hr: number
  credits: number
  estimated_seconds_remaining: number
  has_2k_addon: boolean
}

// ── Platform metadata ─────────────────────────────────────────────────────────

const PLATFORM_META: Record<string, {
  label: string
  supportsPortrait: boolean
  defaultBitrate: number
  bitrateMin: number
  bitrateMax: number
  encodeType: 'transcode' | 'passthrough'
  defaultOrientation: 'landscape' | 'portrait'
}> = {
  twitch:  { label: 'Twitch',   supportsPortrait: false, defaultBitrate: 6000, bitrateMin: 2500, bitrateMax: 8000, encodeType: 'transcode',  defaultOrientation: 'landscape' },
  kick:    { label: 'Kick',     supportsPortrait: false, defaultBitrate: 6000, bitrateMin: 2500, bitrateMax: 8000, encodeType: 'transcode',  defaultOrientation: 'landscape' },
  youtube: { label: 'YouTube',  supportsPortrait: true,  defaultBitrate: 6000, bitrateMin: 2500, bitrateMax: 8000, encodeType: 'passthrough', defaultOrientation: 'landscape' },
  tiktok:  { label: 'TikTok',   supportsPortrait: true,  defaultBitrate: 4000, bitrateMin: 1000, bitrateMax: 4500, encodeType: 'transcode',  defaultOrientation: 'portrait' },
}

const PLATFORM_ORDER = ['twitch', 'kick', 'youtube', 'tiktok']

const PLATFORM_ICONS: Record<string, string> = {
  twitch:  'T',
  kick:    'K',
  youtube: 'YT',
  tiktok:  'TK',
}

const PLATFORM_ICON_COLORS: Record<string, string> = {
  twitch:  'bg-purple-600',
  kick:    'bg-green-600',
  youtube: 'bg-red-600',
  tiktok:  'bg-pink-600',
}

const RESOLUTIONS = ['720p', '1080p', '1440p'] as const

// ── OBS Connection sub-section ────────────────────────────────────────────────

function OBSConnectionSection() {
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [keyLoading, setKeyLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  async function generateApiKey() {
    if (!window.confirm("Reset access? This disconnects every linked OBS device and the old manual key. You'll need to reconnect.")) return
    setKeyLoading(true)
    try {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const res = await fetch('/api/apikey', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await res.json()
      setApiKey(body.api_key)
    } finally {
      setKeyLoading(false)
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div>
      <div className="text-xs text-ink-faint mb-3 leading-relaxed">
        In OBS, open the SlimCast panel and click <span className="text-ink-muted">Connect with SlimCast</span> — no key needed.
        Use a manual key only as a fallback. Resetting revokes <span className="text-ink-muted">all</span> connected devices.
      </div>
      {apiKey ? (
        <div className="space-y-3">
          <div className="bg-amber-950/30 border border-amber-800/60 rounded-lg px-3 py-2 text-xs text-amber-400">
            Copy this now — it won&apos;t be shown again.
          </div>
          <div className="flex items-center gap-3">
            <code className="flex-1 bg-base border border-line rounded-lg px-3 py-2 text-sm font-mono text-ink break-all">
              {apiKey}
            </code>
            <button
              onClick={() => copy(apiKey)}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors min-w-[70px] ${copied ? 'bg-accent text-base' : 'bg-elevated hover:bg-line-strong text-ink'}`}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={generateApiKey}
          disabled={keyLoading}
          className="bg-elevated hover:bg-line-strong disabled:opacity-50 px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
        >
          {keyLoading ? 'Resetting…' : 'Reset access · new manual key'}
        </button>
      )}
    </div>
  )
}

// ── Bitrate number input ──────────────────────────────────────────────────────

function BitrateInput({
  value, min, max, onChange,
}: {
  value: number; min: number; max: number; onChange: (v: number) => void
}) {
  const [raw, setRaw] = useState(String(value))

  useEffect(() => { setRaw(String(value)) }, [value])

  function commit(str: string) {
    const n = parseInt(str, 10)
    if (isNaN(n)) { setRaw(String(value)); return }
    const clamped = Math.min(max, Math.max(min, n))
    setRaw(String(clamped))
    onChange(clamped)
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        max={max}
        step={250}
        value={raw}
        onChange={e => setRaw(e.target.value)}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value) }}
        className="w-24 bg-base border border-line rounded-lg px-2 py-1.5 text-sm font-mono text-ink focus:outline-none focus:border-accent transition-colors text-center"
      />
      <span className="text-xs text-ink-faint">kbps</span>
    </div>
  )
}

// ── Cost summary panel ────────────────────────────────────────────────────────

function CostSummary({ pricing, loading }: { pricing: PricingBreakdown | null; loading: boolean }) {
  if (loading || !pricing) {
    return (
      <div className="bg-surface border border-line rounded-2xl p-5">
        <div className="text-xs text-ink-faint">Calculating cost…</div>
      </div>
    )
  }

  const { line_items, total_tokens_per_hr, total_dollars_per_hr, credits, estimated_seconds_remaining } = pricing
  const hasItems = line_items.length > 0
  const remaining = secondsRemaining(credits, total_tokens_per_hr)

  return (
    <div className="bg-surface border border-line rounded-2xl overflow-hidden">
      <div className="px-5 pt-5 pb-4">
        <div className="text-xs text-ink-faint uppercase tracking-widest font-mono mb-4">Cost summary</div>

        {!hasItems ? (
          <div className="text-sm text-ink-faint">Enable at least one platform to see costs.</div>
        ) : (
          <div className="space-y-2">
            {line_items.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <div>
                  <span className="text-ink capitalize">{item.label}</span>
                  <span className="text-ink-faint text-xs ml-2">{item.detail}</span>
                </div>
                <span className={`font-mono text-xs tabular-nums ${item.tokens_per_hr === 0 ? 'text-ink-faint' : 'text-ink'}`}>
                  {item.tokens_per_hr === 0 ? 'free' : `+${item.tokens_per_hr.toFixed(1)} tkn/hr`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {hasItems && (
        <div className="border-t border-line px-5 py-4 flex items-center justify-between">
          <div>
            <div className="text-base font-bold font-mono text-ink">
              {total_tokens_per_hr.toFixed(1)} tkn/hr
            </div>
            <div className="text-xs text-ink-faint mt-0.5">
              ${total_dollars_per_hr.toFixed(2)}/hr · {formatTokens(credits)} balance
            </div>
          </div>
          <div className="text-right">
            <div className="text-base font-bold font-mono text-ink">
              {formatDuration(remaining)}
            </div>
            <div className="text-xs text-ink-faint">at this rate</div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Platform output card ──────────────────────────────────────────────────────

interface OutputCardProps {
  platform: string
  config: PlatformConfig
  settings: OutputSettings
  has2kAddon: boolean
  onToggle: (enabled: boolean) => void
  onOrientationChange: (orientation: string) => void
  onResolutionChange: (resolution: '720p' | '1080p' | '1440p') => void
  onBitrateChange: (bitrate: number) => void
  onPassthroughChange: (use: boolean) => void
  onRecheckEligibility: () => void
  saving: boolean
}

function OutputCard({
  platform, config, settings, has2kAddon,
  onToggle, onOrientationChange, onResolutionChange, onBitrateChange,
  onPassthroughChange, onRecheckEligibility,
  saving,
}: OutputCardProps) {
  const meta = PLATFORM_META[platform]
  if (!meta) return null

  // Twitch HEVC passthrough is available only to eligible (Partner/select-Affiliate)
  // channels and only when the user opts in; otherwise Twitch is an H.264 transcode.
  const twitchEligible = platform === 'twitch' && !!config.twitch_hevc_eligible
  const twitchPassthrough = twitchEligible && (config.twitch_use_passthrough ?? true)

  const resolution = settings.resolution ?? '1080p'
  const bitrate = settings.bitrate_kbps ?? meta.defaultBitrate
  const orientation = config.orientation ?? meta.defaultOrientation
  const isPassthrough = orientation === 'landscape' && (meta.encodeType === 'passthrough' || twitchPassthrough)

  const encodeLabel = isPassthrough ? 'HEVC passthrough' : orientation === 'portrait' ? 'Portrait' : 'Landscape'
  const encodeColor = isPassthrough
    ? 'text-blue-400'
    : orientation === 'portrait' ? 'text-pink-400' : 'text-accent'

  return (
    <div className={`bg-surface border rounded-2xl p-5 transition-opacity ${!config.enabled ? 'opacity-50' : ''} ${config.enabled ? 'border-line' : 'border-line/40'}`}>
      <div className="flex items-start gap-4">
        {/* Platform icon */}
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold text-white flex-shrink-0 ${PLATFORM_ICON_COLORS[platform]}`}>
          {PLATFORM_ICONS[platform]}
        </div>

        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-ink">{meta.label}</span>
                <span className={`text-xs font-mono ${encodeColor}`}>{encodeLabel}</span>
                {saving && <span className="text-xs text-ink-faint">saving…</span>}
              </div>
            </div>
            <button
              onClick={() => onToggle(!config.enabled)}
              className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${config.enabled ? 'bg-accent' : 'bg-line-strong'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${config.enabled ? 'translate-x-4' : ''}`} />
            </button>
          </div>

          {/* Twitch HEVC eligibility / passthrough control */}
          {platform === 'twitch' && (
            twitchEligible ? (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-blue-500/10 border border-blue-500/20 px-3 py-2">
                <div className="text-xs">
                  <div className="font-semibold text-blue-300">HEVC passthrough available · up to 2K</div>
                  <div className="text-ink-faint">
                    {twitchPassthrough
                      ? 'Sending your source HEVC untouched — best quality, no transcode.'
                      : 'Currently transcoding to H.264 (≤1080p). Turn on for original-quality 2K.'}
                  </div>
                </div>
                <button
                  onClick={() => onPassthroughChange(!twitchPassthrough)}
                  title="HEVC passthrough"
                  className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${twitchPassthrough ? 'bg-blue-500' : 'bg-line-strong'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${twitchPassthrough ? 'translate-x-4' : ''}`} />
                </button>
              </div>
            ) : (
              <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-base border border-line/60 px-3 py-2">
                <div className="text-xs text-ink-faint">
                  <span className="text-ink-muted">H.264 transcode.</span> HEVC / 2K passthrough needs Twitch Affiliate status.
                </div>
                <button
                  onClick={onRecheckEligibility}
                  disabled={saving}
                  className="text-xs font-semibold px-2.5 py-1 rounded-lg bg-surface border border-line text-ink-muted hover:border-accent/50 hover:text-ink disabled:opacity-50 flex-shrink-0"
                >
                  {saving ? 'Checking…' : 'Re-check'}
                </button>
              </div>
            )
          )}

          {/* Settings row */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            {/* Resolution selector */}
            {!isPassthrough && (
              <div>
                <div className="text-xs text-ink-faint mb-1.5">Resolution</div>
                <div className="flex gap-1">
                  {RESOLUTIONS.map(res => {
                    // Twitch only accepts 2K via HEVC passthrough — never as an H.264
                    // transcode — so 1440p is unavailable in Twitch's transcode mode.
                    const isLocked = res === '1440p' && (platform === 'twitch' || !has2kAddon)
                    const lockTitle = platform === 'twitch'
                      ? 'Twitch 2K requires HEVC passthrough (Affiliate)'
                      : 'Requires 2K add-on'
                    return (
                      <button
                        key={res}
                        disabled={isLocked}
                        onClick={() => !isLocked && onResolutionChange(res)}
                        title={isLocked ? lockTitle : undefined}
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                          resolution === res
                            ? 'bg-accent text-base'
                            : isLocked
                              ? 'bg-base border border-line/40 text-ink-faint/40 cursor-not-allowed'
                              : 'bg-base border border-line text-ink-muted hover:border-accent/50 hover:text-ink'
                        }`}
                      >
                        {res}{isLocked ? ' 🔒' : ''}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Bitrate input */}
            {!isPassthrough && (
              <div>
                <div className="text-xs text-ink-faint mb-1.5">Bitrate</div>
                <BitrateInput
                  value={bitrate}
                  min={meta.bitrateMin}
                  max={meta.bitrateMax}
                  onChange={onBitrateChange}
                />
                <div className="text-xs text-ink-faint/60 mt-1">
                  {meta.bitrateMin.toLocaleString()}–{meta.bitrateMax.toLocaleString()}
                </div>
              </div>
            )}

            {/* Orientation selector (platforms that support it) */}
            {meta.supportsPortrait && (
              <div>
                <div className="text-xs text-ink-faint mb-1.5">Orientation</div>
                <div className="flex gap-1">
                  {['landscape', 'portrait'].map(o => (
                    <button
                      key={o}
                      onClick={() => onOrientationChange(o)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors capitalize ${
                        orientation === o
                          ? 'bg-accent text-base'
                          : 'bg-base border border-line text-ink-muted hover:border-accent/50 hover:text-ink'
                      }`}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Passthrough info */}
            {isPassthrough && (
              <div className="text-xs text-ink-faint">
                Original quality — your source goes through untouched.
                <br />Bitrate is whatever OBS sends.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter()

  const [platforms, setPlatforms] = useState<PlatformConfig[]>([])
  const [outputSettings, setOutputSettings] = useState<OutputSettingsMap>({})
  const [has2kAddon, setHas2kAddon] = useState(false)
  const [pricing, setPricing] = useState<PricingBreakdown | null>(null)
  const [pricingLoading, setPricingLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)

  const [showPortraitCrop, setShowPortraitCrop] = useState(false)
  const [showOBSSection, setShowOBSSection] = useState(false)

  const hasPortrait = platforms.some(p => p.orientation === 'portrait' && PLATFORM_META[p.platform]?.supportsPortrait)

  async function authHeader() {
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    return session
      ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
      : null
  }

  const loadPricing = useCallback(async (headers: Record<string, string>) => {
    setPricingLoading(true)
    try {
      const res = await fetch('/api/pricing', { headers })
      if (res.ok) setPricing(await res.json())
    } finally {
      setPricingLoading(false)
    }
  }, [])

  useEffect(() => {
    async function load() {
      const supabase = createBrowserClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const headers = await authHeader()
      if (!headers) { router.push('/login'); return }

      const [{ data: platformData }, settingsRes, pricingRes] = await Promise.all([
        supabase
          .from('platform_connections')
          .select('platform, orientation, enabled, twitch_hevc_eligible, twitch_use_passthrough, twitch_max_height')
          .eq('user_id', user.id)
          .order('platform'),
        fetch('/api/output-settings', { headers }),
        fetch('/api/pricing', { headers }),
      ])

      setPlatforms((platformData ?? []) as PlatformConfig[])

      if (settingsRes.ok) {
        const body = await settingsRes.json()
        setOutputSettings(body.output_settings ?? {})
        setHas2kAddon(body.has_2k_addon ?? false)
      }

      if (pricingRes.ok) {
        const body = await pricingRes.json()
        setPricing(body)
      }
      setPricingLoading(false)
      setLoaded(true)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  async function togglePlatform(platformId: string, enabled: boolean) {
    setPlatforms(prev => prev.map(p => p.platform === platformId ? { ...p, enabled } : p))
    const headers = await authHeader()
    if (!headers) return
    setSaving(platformId)
    await fetch(`/api/platforms/${platformId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ enabled }),
    })
    setSaving(null)
    await loadPricing(headers)
  }

  async function setOrientation(platformId: string, orientation: string) {
    setPlatforms(prev => prev.map(p => p.platform === platformId ? { ...p, orientation } : p))
    const headers = await authHeader()
    if (!headers) return
    setSaving(platformId)
    await fetch(`/api/platforms/${platformId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ orientation }),
    })
    setSaving(null)
    await loadPricing(headers)
  }

  async function setResolution(platformId: string, resolution: '720p' | '1080p' | '1440p') {
    setOutputSettings(prev => ({
      ...prev,
      [platformId]: { ...(prev[platformId] ?? {}), resolution },
    }))
    const headers = await authHeader()
    if (!headers) return
    setSaving(platformId)
    await fetch('/api/output-settings', {
      method: 'PATCH', headers,
      body: JSON.stringify({ [platformId]: { resolution } }),
    })
    setSaving(null)
    await loadPricing(headers)
  }

  async function setBitrate(platformId: string, bitrate_kbps: number) {
    setOutputSettings(prev => ({
      ...prev,
      [platformId]: { ...(prev[platformId] ?? {}), bitrate_kbps },
    }))
    const headers = await authHeader()
    if (!headers) return
    setSaving(platformId)
    await fetch('/api/output-settings', {
      method: 'PATCH', headers,
      body: JSON.stringify({ [platformId]: { bitrate_kbps } }),
    })
    setSaving(null)
    // Bitrate doesn't affect pricing; no need to reload.
  }

  // Twitch-only: toggle HEVC passthrough vs H.264 transcode (eligible channels).
  async function setTwitchPassthrough(use: boolean) {
    setPlatforms(prev => prev.map(p => p.platform === 'twitch' ? { ...p, twitch_use_passthrough: use } : p))
    const headers = await authHeader()
    if (!headers) return
    setSaving('twitch')
    await fetch('/api/platforms/twitch', {
      method: 'PATCH', headers, body: JSON.stringify({ twitch_use_passthrough: use }),
    })
    setSaving(null)
    await loadPricing(headers)
  }

  // Twitch-only: re-probe HEVC eligibility (e.g. after becoming an Affiliate).
  async function recheckTwitchEligibility() {
    const headers = await authHeader()
    if (!headers) return
    setSaving('twitch')
    const res = await fetch('/api/platforms/twitch', {
      method: 'PATCH', headers, body: JSON.stringify({ recheck_eligibility: true }),
    })
    if (res.ok) {
      const body = await res.json() as { hevcEligible?: boolean; maxHeight?: number }
      setPlatforms(prev => prev.map(p => p.platform === 'twitch'
        ? { ...p, twitch_hevc_eligible: !!body.hevcEligible, twitch_max_height: body.maxHeight ?? 1080 }
        : p))
    }
    setSaving(null)
  }

  if (!loaded) {
    return (
      <div className="min-h-screen">
        <DashboardNav />
        <div className="flex items-center justify-center py-32 text-ink-faint text-sm">Loading…</div>
      </div>
    )
  }

  if (platforms.length === 0) {
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

  const connectedPlatforms = PLATFORM_ORDER.filter(p => platforms.some(c => c.platform === p))

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="max-w-2xl mx-auto px-6 py-10 space-y-5">

        {/* Header */}
        <div>
          <h1 className="text-lg font-semibold">Stream settings</h1>
          <p className="text-sm text-ink-muted mt-1">
            Per-output resolution and bitrate. Changes apply within ~10s, even mid-stream.
            Resolution and frame rate in OBS override these per-output settings.
          </p>
        </div>

        {/* Output cards */}
        <div className="space-y-3">
          {connectedPlatforms.map(platformId => {
            const config = platforms.find(p => p.platform === platformId)
            if (!config) return null
            return (
              <OutputCard
                key={platformId}
                platform={platformId}
                config={config}
                settings={outputSettings[platformId] ?? {}}
                has2kAddon={has2kAddon}
                onToggle={enabled => togglePlatform(platformId, enabled)}
                onOrientationChange={orientation => setOrientation(platformId, orientation)}
                onResolutionChange={resolution => setResolution(platformId, resolution)}
                onBitrateChange={bitrate => setBitrate(platformId, bitrate)}
                onPassthroughChange={setTwitchPassthrough}
                onRecheckEligibility={recheckTwitchEligibility}
                saving={saving === platformId}
              />
            )
          })}
        </div>

        {/* Cost summary */}
        <CostSummary pricing={pricing} loading={pricingLoading} />

        {/* 2K add-on notice */}
        {!has2kAddon && (
          <div className="bg-base border border-line rounded-xl px-4 py-3 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-ink-muted">2K (1440p) add-on</div>
              <div className="text-xs text-ink-faint mt-0.5">
                +0.5 tkn/hr when active. Unlocks 1440p resolution on any output.
              </div>
            </div>
            <span className="text-xs text-ink-faint bg-elevated px-2.5 py-1 rounded-lg shrink-0">Not active</span>
          </div>
        )}

        {/* Portrait framing — collapsible */}
        {hasPortrait && (
          <div className="bg-surface border border-line rounded-2xl overflow-hidden">
            <button
              onClick={() => setShowPortraitCrop(v => !v)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-elevated/30 transition-colors"
            >
              <div>
                <div className="text-sm font-semibold text-left">Vertical framing</div>
                <div className="text-xs text-ink-faint mt-0.5 text-left">Set the 9:16 crop applied to portrait outputs</div>
              </div>
              <span className={`text-ink-faint text-xs transition-transform ${showPortraitCrop ? 'rotate-180' : ''}`}>▾</span>
            </button>
            {showPortraitCrop && (
              <div className="px-5 pb-5 border-t border-line pt-4">
                <p className="text-xs text-ink-muted mb-4">
                  Your source is 16:9; portrait platforms need 9:16. Set how the vertical crop is framed — cropped once on the GPU and sent to every portrait platform.
                </p>
                <PortraitCropEditor />
              </div>
            )}
          </div>
        )}

        {/* OBS connection — collapsible */}
        <div className="bg-surface border border-line rounded-2xl overflow-hidden">
          <button
            onClick={() => setShowOBSSection(v => !v)}
            className="w-full flex items-center justify-between px-5 py-4 hover:bg-elevated/30 transition-colors"
          >
            <div>
              <div className="text-sm font-semibold text-left">OBS connection</div>
              <div className="text-xs text-ink-faint mt-0.5 text-left">Manual key reset and device management</div>
            </div>
            <span className={`text-ink-faint text-xs transition-transform ${showOBSSection ? 'rotate-180' : ''}`}>▾</span>
          </button>
          {showOBSSection && (
            <div className="px-5 pb-5 border-t border-line pt-4">
              <OBSConnectionSection />
            </div>
          )}
        </div>

      </main>
    </div>
  )
}
