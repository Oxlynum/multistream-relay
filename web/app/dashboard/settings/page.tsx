'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'
import { PortraitCropEditor } from '@/components/portrait-crop-editor'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { PlatformIcon, PLATFORM_META as PLATFORM_TINTS, type PlatformKey } from '@/components/platform-icon'
import { cn } from '@/lib/utils'
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

const RESOLUTIONS = ['720p', '1080p', '1440p'] as const

// ── Segmented option button ───────────────────────────────────────────────────

function SegButton({
  active, disabled, title, onClick, children,
}: {
  active: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        'rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors',
        active
          ? 'bg-brand text-primary-foreground'
          : disabled
            ? 'cursor-not-allowed border border-line/40 bg-surface-2 text-ink-faint/40'
            : 'border border-line bg-surface-2 text-ink-muted hover:border-brand/50 hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}

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
      <div className="mb-3 text-xs leading-relaxed text-ink-faint">
        In OBS, open the SlimCast panel and click <span className="text-ink-muted">Connect with SlimCast</span> — no key needed.
        Use a manual key only as a fallback. Resetting revokes <span className="text-ink-muted">all</span> connected devices.
      </div>
      {apiKey ? (
        <div className="space-y-3">
          <Alert className="border-warning/40 bg-warning/10">
            <AlertDescription className="text-warning">
              Copy this now — it won&apos;t be shown again.
            </AlertDescription>
          </Alert>
          <div className="flex items-center gap-3">
            <code className="flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm break-all text-ink">
              {apiKey}
            </code>
            <Button
              variant={copied ? 'default' : 'secondary'}
              onClick={() => copy(apiKey)}
              className={cn('h-9 min-w-[72px]', copied && 'bg-success text-bg hover:bg-success')}
            >
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" onClick={generateApiKey} disabled={keyLoading} className="h-9 font-semibold">
          {keyLoading ? 'Resetting…' : 'Reset access · new manual key'}
        </Button>
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
      <Input
        type="number"
        min={min}
        max={max}
        step={250}
        value={raw}
        onChange={e => setRaw(e.target.value)}
        onBlur={e => commit(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value) }}
        className="h-8 w-24 text-center font-mono"
      />
      <span className="text-xs text-ink-faint">kbps</span>
    </div>
  )
}

// ── Cost summary panel ────────────────────────────────────────────────────────

function CostSummary({ pricing, loading }: { pricing: PricingBreakdown | null; loading: boolean }) {
  if (loading || !pricing) {
    return (
      <Card className="border-line">
        <CardContent className="py-1">
          <div className="text-xs text-ink-faint">Calculating cost…</div>
        </CardContent>
      </Card>
    )
  }

  const { line_items, total_tokens_per_hr, total_dollars_per_hr, credits } = pricing
  const hasItems = line_items.length > 0
  const remaining = secondsRemaining(credits, total_tokens_per_hr)

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="px-5 pt-5 pb-4">
        <div className="mb-4 font-mono text-xs tracking-widest text-ink-faint uppercase">Cost summary</div>

        {!hasItems ? (
          <div className="text-sm text-ink-faint">Enable at least one platform to see costs.</div>
        ) : (
          <div className="space-y-2">
            {line_items.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <div>
                  <span className="text-ink capitalize">{item.label}</span>
                  <span className="ml-2 text-xs text-ink-faint">{item.detail}</span>
                </div>
                <span className={cn('font-mono text-xs tabular-nums', item.tokens_per_hr === 0 ? 'text-ink-faint' : 'text-ink')}>
                  {item.tokens_per_hr === 0 ? 'free' : `+${item.tokens_per_hr.toFixed(1)} tkn/hr`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {hasItems && (
        <div className="flex items-center justify-between border-t border-line px-5 py-4">
          <div>
            <div className="font-mono text-base font-bold text-ink">
              {total_tokens_per_hr.toFixed(1)} tkn/hr
            </div>
            <div className="mt-0.5 text-xs text-ink-faint">
              ${total_dollars_per_hr.toFixed(2)}/hr · {formatTokens(credits)} balance
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-base font-bold text-ink">
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
    ? 'text-cyan'
    : orientation === 'portrait' ? 'text-pink' : 'text-brand'

  const tint = PLATFORM_TINTS[platform as PlatformKey]?.tint

  return (
    <Card className={cn('border-line transition-opacity', !config.enabled && 'opacity-50')}>
      <CardContent className="py-1">
        <div className="flex items-start gap-4">
          {/* Platform icon */}
          <span
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
            style={{ borderColor: `${tint}40`, color: tint, background: `${tint}14` }}
          >
            <PlatformIcon platform={platform as PlatformKey} className="h-5 w-5" />
          </span>

          <div className="min-w-0 flex-1">
            {/* Header row */}
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-display font-semibold text-ink">{meta.label}</span>
                <span className={cn('font-mono text-xs', encodeColor)}>{encodeLabel}</span>
                {saving && <span className="text-xs text-ink-faint">saving…</span>}
              </div>
              <Switch checked={config.enabled} onCheckedChange={onToggle} />
            </div>

            {/* Twitch HEVC eligibility / passthrough control */}
            {platform === 'twitch' && (
              twitchEligible ? (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-cyan/20 bg-cyan/10 px-3 py-2">
                  <div className="text-xs">
                    <div className="font-semibold text-cyan">HEVC passthrough available · up to 2K</div>
                    <div className="text-ink-faint">
                      {twitchPassthrough
                        ? 'Sending your source HEVC untouched — best quality, no transcode.'
                        : 'Currently transcoding to H.264 (≤1080p). Turn on for original-quality 2K.'}
                    </div>
                  </div>
                  <Switch
                    checked={twitchPassthrough}
                    onCheckedChange={onPassthroughChange}
                  />
                </div>
              ) : (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-line/60 bg-surface-2 px-3 py-2">
                  <div className="text-xs text-ink-faint">
                    <span className="text-ink-muted">H.264 transcode.</span> HEVC / 2K passthrough needs Twitch Affiliate status.
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onRecheckEligibility}
                    disabled={saving}
                    className="shrink-0"
                  >
                    {saving ? 'Checking…' : 'Re-check'}
                  </Button>
                </div>
              )
            )}

            {/* Settings row */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              {/* Resolution selector */}
              {!isPassthrough && (
                <div>
                  <div className="mb-1.5 text-xs text-ink-faint">Resolution</div>
                  <div className="flex gap-1">
                    {RESOLUTIONS.map(res => {
                      // Twitch only accepts 2K via HEVC passthrough — never as an H.264
                      // transcode — so 1440p is unavailable in Twitch's transcode mode.
                      const isLocked = res === '1440p' && (platform === 'twitch' || !has2kAddon)
                      const lockTitle = platform === 'twitch'
                        ? 'Twitch 2K requires HEVC passthrough (Affiliate)'
                        : 'Requires 2K add-on'
                      return (
                        <SegButton
                          key={res}
                          active={resolution === res}
                          disabled={isLocked}
                          title={isLocked ? lockTitle : undefined}
                          onClick={() => !isLocked && onResolutionChange(res)}
                        >
                          {res}{isLocked ? ' 🔒' : ''}
                        </SegButton>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Bitrate input */}
              {!isPassthrough && (
                <div>
                  <div className="mb-1.5 text-xs text-ink-faint">Bitrate</div>
                  <BitrateInput
                    value={bitrate}
                    min={meta.bitrateMin}
                    max={meta.bitrateMax}
                    onChange={onBitrateChange}
                  />
                  <div className="mt-1 text-xs text-ink-faint/60">
                    {meta.bitrateMin.toLocaleString()}–{meta.bitrateMax.toLocaleString()}
                  </div>
                </div>
              )}

              {/* Orientation selector (platforms that support it) */}
              {meta.supportsPortrait && (
                <div>
                  <div className="mb-1.5 text-xs text-ink-faint">Orientation</div>
                  <div className="flex gap-1">
                    {['landscape', 'portrait'].map(o => (
                      <SegButton
                        key={o}
                        active={orientation === o}
                        onClick={() => onOrientationChange(o)}
                      >
                        <span className="capitalize">{o}</span>
                      </SegButton>
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
      </CardContent>
    </Card>
  )
}

// ── Danger zone: delete account ───────────────────────────────────────────────

function DeleteAccountSection() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [forfeit, setForfeit] = useState(false)
  const [balance, setBalance] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Enabled only once the user typed DELETE and, if a balance was surfaced (the 409
  // below), explicitly checked the forfeit box.
  const canDelete = confirmText === 'DELETE' && (balance == null || balance === 0 || forfeit) && !deleting

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    try {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ forfeitBalance: forfeit }),
      })

      if (res.status === 409) {
        const b = await res.json().catch(() => ({}))
        if (b.error === 'hosting_shared_hub') {
          // The user spawned a shared streaming server other people are still using.
          setError('Your streaming server is currently shared with other active streams. Try again in a few minutes once it’s idle.')
          return
        }
        // Purchased tokens remain — surface the balance and require explicit forfeit.
        setBalance(Number(b.balance ?? 0))
        setError('You still have a token balance. Check the box below to confirm you’re forfeiting it, then delete.')
        return
      }
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        setError(b.error === 'subscription_cancel_failed'
          ? 'Couldn’t cancel your subscription. Open billing, cancel there, then try again.'
          : 'Something went wrong. Please try again.')
        return
      }

      await supabase.auth.signOut()
      router.push('/')
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-danger/30 bg-surface">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between px-5 py-4 transition-colors hover:bg-danger/5"
      >
        <div>
          <div className="text-left text-sm font-semibold text-danger">Delete account</div>
          <div className="mt-0.5 text-left text-xs text-ink-faint">Permanently remove your account and all data</div>
        </div>
        <span className={cn('text-xs text-ink-faint transition-transform', open && 'rotate-180')}>▾</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-danger/20 px-5 pt-4 pb-5">
          <div className="text-xs leading-relaxed text-ink-muted">
            This <span className="font-medium text-danger">permanently deletes</span> your account: stream keys,
            platform connections, and history. Any active stream is stopped, its server destroyed, and any
            subscription canceled immediately. This cannot be undone.
          </div>

          {balance != null && balance > 0 && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2.5">
              <input
                type="checkbox"
                checked={forfeit}
                onChange={e => setForfeit(e.target.checked)}
                className="mt-0.5 accent-danger"
              />
              <span className="text-xs text-ink-muted">
                I understand I’m forfeiting my remaining <span className="font-medium text-ink">{formatTokens(balance)}</span> —
                they’re non-refundable and will be lost.
              </span>
            </label>
          )}

          <div>
            <div className="mb-1.5 text-xs text-ink-faint">Type <span className="font-mono text-ink-muted">DELETE</span> to confirm</div>
            <Input
              type="text"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder="DELETE"
              className="h-9 font-mono"
            />
          </div>

          {error && <div className="text-xs text-danger">{error}</div>}

          <button
            onClick={handleDelete}
            disabled={!canDelete}
            className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {deleting ? 'Deleting…' : 'Permanently delete my account'}
          </button>
        </div>
      )}
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
        <div className="flex items-center justify-center py-32 text-sm text-ink-faint">Loading…</div>
      </div>
    )
  }

  if (platforms.length === 0) {
    return (
      <div className="min-h-screen">
        <DashboardNav />
        <div className="mx-auto max-w-2xl px-6 py-16 text-center text-ink-muted">
          <p className="mb-4">No platforms connected yet.</p>
          <a href="/dashboard/platforms" className="text-brand hover:text-cyan">Connect platforms →</a>
        </div>
      </div>
    )
  }

  const connectedPlatforms = PLATFORM_ORDER.filter(p => platforms.some(c => c.platform === p))

  return (
    <div className="min-h-screen">
      <DashboardNav />

      <main className="mx-auto max-w-2xl space-y-5 px-6 py-10">

        {/* Header */}
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">Stream settings</h1>
          <p className="mt-1 text-sm text-ink-muted">
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
          <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface-2 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-ink-muted">2K (1440p) add-on</div>
              <div className="mt-0.5 text-xs text-ink-faint">
                +0.5 tkn/hr when active. Unlocks 1440p resolution on any output.
              </div>
            </div>
            <span className="shrink-0 rounded-lg bg-surface-3 px-2.5 py-1 text-xs text-ink-faint">Not active</span>
          </div>
        )}

        {/* Portrait framing — collapsible */}
        {hasPortrait && (
          <div className="overflow-hidden rounded-2xl border border-line bg-surface">
            <button
              onClick={() => setShowPortraitCrop(v => !v)}
              className="flex w-full items-center justify-between px-5 py-4 transition-colors hover:bg-surface-2/40"
            >
              <div>
                <div className="text-left text-sm font-semibold text-ink">Vertical framing</div>
                <div className="mt-0.5 text-left text-xs text-ink-faint">Set the 9:16 crop applied to portrait outputs</div>
              </div>
              <span className={cn('text-xs text-ink-faint transition-transform', showPortraitCrop && 'rotate-180')}>▾</span>
            </button>
            {showPortraitCrop && (
              <div className="border-t border-line px-5 pt-4 pb-5">
                <p className="mb-4 text-xs text-ink-muted">
                  Your source is 16:9; portrait platforms need 9:16. Set how the vertical crop is framed — cropped once on the GPU and sent to every portrait platform.
                </p>
                <PortraitCropEditor />
              </div>
            )}
          </div>
        )}

        {/* OBS connection — collapsible */}
        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <button
            onClick={() => setShowOBSSection(v => !v)}
            className="flex w-full items-center justify-between px-5 py-4 transition-colors hover:bg-surface-2/40"
          >
            <div>
              <div className="text-left text-sm font-semibold text-ink">OBS connection</div>
              <div className="mt-0.5 text-left text-xs text-ink-faint">Manual key reset and device management</div>
            </div>
            <span className={cn('text-xs text-ink-faint transition-transform', showOBSSection && 'rotate-180')}>▾</span>
          </button>
          {showOBSSection && (
            <div className="border-t border-line px-5 pt-4 pb-5">
              <OBSConnectionSection />
            </div>
          )}
        </div>

        {/* Danger zone — delete account */}
        <DeleteAccountSection />

      </main>
    </div>
  )
}
