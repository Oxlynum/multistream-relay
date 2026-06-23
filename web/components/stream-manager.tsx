'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { secondsRemaining, formatTokens } from '@/lib/billing'

interface OutputStatus {
  name: string
  state: string
  mode: string
  platforms: string[]
  restarts: number
}

interface GpuStatus {
  status: string
  streaming: boolean
  burn_rate: number
  credits_seconds: number
  outputs: OutputStatus[]
  datacenter: string | null
  gpu_type: string | null
  confirm_required: boolean
  confirm_deadline: string | null
  hls_available: boolean
}

const PLATFORM_ORDER = ['twitch', 'kick', 'youtube', 'tiktok'] as const
const PLATFORM_LABELS: Record<string, string> = {
  twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', tiktok: 'TikTok',
}

function platformStateMap(outputs: OutputStatus[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const o of outputs) {
    for (const p of o.platforms ?? []) {
      map[p] = o.state
    }
  }
  return map
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return `${m}:${String(ss).padStart(2, '0')}`
}

function fmtRemaining(seconds: number): string {
  if (seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0 && m > 0) return `${h}h ${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}

const GPU_LABELS: Record<string, string> = {
  a4000: 'RTX A4000', a5000: 'RTX A5000', l4: 'L4',
  a40: 'A40', rtx3090: 'RTX 3090', rtxpro4000: 'RTX PRO 4000',
  rtx4090: 'RTX 4090', rtxpro4500: 'RTX PRO 4500',
  rtx6000ada: 'RTX 6000 Ada', l40s: 'L40S', rtx5090: 'RTX 5090',
}

// HLS proxy URL — auth token is passed as a query param so the <video> src
// can carry it without a custom fetch (the route also accepts Authorization header,
// but <video> src doesn't support custom headers in the browser).
function hlsProxyUrl(token: string) {
  return `/api/gpu/hls/index.m3u8?token=${encodeURIComponent(token)}`
}

// ── HLS Video Player ─────────────────────────────────────────────────────────
interface HlsPlayerProps {
  src: string
  onError: (msg: string) => void
}

function HlsPlayer({ src, onError }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<import('hls.js').default | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let destroyed = false

    async function setup() {
      const Hls = (await import('hls.js')).default

      if (destroyed) return

      if (Hls.isSupported()) {
        const hls = new Hls({
          maxBufferLength: 10,
          backBufferLength: 0,
        })
        hlsRef.current = hls
        hls.loadSource(src)
        hls.attachMedia(video!)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video!.play().catch(() => {/* autoplay blocked — user can press play */})
        })
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) {
            onError('Preview unavailable — stream may not be active yet.')
          }
        })
      } else if (video!.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari handles HLS natively
        video!.src = src
        video!.play().catch(() => {})
      } else {
        onError('Live preview requires Safari or Chrome on Mac.')
      }
    }

    setup()

    return () => {
      destroyed = true
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [src, onError])

  return (
    <video
      ref={videoRef}
      muted
      playsInline
      controls
      className="w-full rounded-xl bg-black aspect-video"
    />
  )
}

// ── Preview Panel ─────────────────────────────────────────────────────────────
interface PreviewPanelProps {
  token: string
}

function PreviewPanel({ token }: PreviewPanelProps) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const src = hlsProxyUrl(token)

  const handleError = useCallback((msg: string) => setError(msg), [])

  return (
    <div className="border-t border-line pt-4">
      <button
        onClick={() => { setOpen(o => !o); setError(null) }}
        className="flex items-center gap-2 text-xs text-ink-muted hover:text-ink transition-colors"
      >
        <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        {open ? 'Hide preview' : 'Preview live feed'}
      </button>

      {open && (
        <div className="mt-3">
          {error ? (
            <div className="text-xs text-ink-faint bg-base border border-line rounded-xl px-4 py-3">
              {error}
            </div>
          ) : (
            <>
              <HlsPlayer src={src} onError={handleError} />
              <p className="text-[10px] text-ink-faint mt-1.5">
                Monitoring feed · ~10–20 s latency · muted by default
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export function StreamManager() {
  const [data, setData] = useState<GpuStatus | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [token, setToken] = useState<string | null>(null)
  const streamStartRef = useRef<number | null>(null)
  const prevStreaming = useRef(false)

  useEffect(() => {
    let active = true

    async function poll() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session || !active) return

      if (!token) setToken(session.access_token)

      const res = await fetch('/api/gpu/status', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => null)
      if (!res?.ok || !active) return
      const body: GpuStatus = await res.json()
      setData(body)

      if (body.streaming && !prevStreaming.current) {
        streamStartRef.current = Date.now()
        setElapsed(0)
      }
      if (!body.streaming) {
        streamStartRef.current = null
      }
      prevStreaming.current = body.streaming
    }

    poll()
    const pollId = setInterval(poll, 5000)
    const tickId = setInterval(() => {
      if (streamStartRef.current) setElapsed(Date.now() - streamStartRef.current)
    }, 1000)

    return () => { active = false; clearInterval(pollId); clearInterval(tickId) }
  }, [token])

  if (!data) return null

  const { status, streaming, burn_rate, credits_seconds, outputs, datacenter, gpu_type, confirm_required, confirm_deadline, hls_available } = data
  const states = platformStateMap(outputs)
  const activePlatforms = PLATFORM_ORDER.filter(p => p in states)
  const remaining = secondsRemaining(credits_seconds, burn_rate)
  const lowCredits = remaining < 1800 && streaming
  const confirmMsLeft = confirm_deadline ? Math.max(0, new Date(confirm_deadline).getTime() - Date.now()) : null
  const confirmMinLeft = confirmMsLeft !== null ? Math.floor(confirmMsLeft / 60000) : null

  // ── Idle ──────────────────────────────────────────────────────────────────
  if (status === 'stopped') {
    return (
      <div className="bg-surface border border-line rounded-2xl p-6 flex items-start gap-3">
        <span className="mt-0.5 h-2.5 w-2.5 rounded-full bg-ink-faint/30 flex-shrink-0" />
        <div>
          <div className="text-sm font-semibold text-ink-muted mb-1">Idle — not streaming</div>
          <div className="text-xs text-ink-faint">
            Press Go Live in OBS to start. Your GPU spins up automatically (~45 s).
          </div>
        </div>
      </div>
    )
  }

  // ── Provisioning ──────────────────────────────────────────────────────────
  if (status === 'provisioning') {
    return (
      <div className="bg-surface border border-amber-800/40 rounded-2xl p-6 flex items-start gap-3">
        <span className="relative mt-0.5 flex h-2.5 w-2.5 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
        </span>
        <div>
          <div className="text-sm font-semibold text-amber-400 mb-1">Starting up…</div>
          <div className="text-xs text-ink-faint">
            Finding the nearest GPU and booting your relay server. Usually ready in under a minute.
          </div>
        </div>
      </div>
    )
  }

  // ── Live ──────────────────────────────────────────────────────────────────
  return (
    <div className={`bg-surface border rounded-2xl p-6 space-y-5 ${lowCredits ? 'border-amber-800/60' : 'border-accent/30'}`}>

      {/* Header: status + session timer + credits */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${streaming ? 'bg-accent' : 'bg-ink-faint'}`} />
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${streaming ? 'bg-accent' : 'bg-ink-faint'}`} />
          </span>
          <div>
            <div className="text-sm font-semibold leading-none">
              {streaming ? 'Live' : 'Ready'}
            </div>
            {streaming && streamStartRef.current && (
              <div className="text-xs text-ink-faint font-mono mt-0.5">
                {fmtElapsed(elapsed)}
              </div>
            )}
          </div>
        </div>

        <div className="text-right flex-shrink-0">
          <div className={`text-base font-bold font-mono ${lowCredits ? 'text-amber-400' : 'text-ink'}`}>
            {formatTokens(credits_seconds)}
          </div>
          <div className="text-xs text-ink-faint">
            {burn_rate > 0 ? `${burn_rate.toFixed(1)} tkn/hr · $${(burn_rate * 2).toFixed(2)}/hr` : 'remaining'}
          </div>
        </div>
      </div>

      {/* Platform tiles */}
      {activePlatforms.length > 0 && (
        <div className={`grid gap-2 ${activePlatforms.length <= 2 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`}>
          {activePlatforms.map(platform => {
            const state = states[platform]
            const isLive = state === 'running'
            const isError = state === 'error'
            const isRestarting = state === 'restarting'
            const dotColor = isLive ? '#37d67a' : isError ? '#ff5470' : isRestarting ? '#ffb020' : '#555e6e'
            const label = isLive ? 'live' : isError ? 'error' : isRestarting ? 'reconnecting' : 'idle'

            return (
              <div
                key={platform}
                className={`bg-base border rounded-xl px-3 py-2.5 ${isError ? 'border-red-900/60' : 'border-line'}`}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span style={{ color: dotColor }} className="text-[10px] leading-none">●</span>
                  <span className="text-xs font-medium text-ink">{PLATFORM_LABELS[platform]}</span>
                </div>
                <div className={`text-xs ${isLive ? 'text-accent' : isError ? 'text-red-400' : isRestarting ? 'text-amber-400' : 'text-ink-faint'}`}>
                  {label}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* GPU info bar */}
      {(gpu_type || datacenter) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-4 text-xs text-ink-faint">
          {gpu_type && (
            <span className="font-medium text-ink-muted">{GPU_LABELS[gpu_type] ?? gpu_type.toUpperCase()}</span>
          )}
          {datacenter && <span>{datacenter}</span>}
          <span className="text-ink-faint/50">·</span>
          <span>RunPod community</span>
        </div>
      )}

      {/* 12h confirm banner */}
      {confirm_required && confirmMinLeft !== null && (
        <div className="bg-amber-950/30 border border-amber-800/60 rounded-xl px-4 py-3 space-y-1">
          <div className="text-sm font-semibold text-amber-400">Still streaming?</div>
          <div className="text-xs text-amber-500/80">
            You've been live 12 hours. This stream ends in {confirmMinLeft} min unless you tap
            <span className="text-amber-400"> Yes, keep streaming</span> in the OBS plugin.
          </div>
        </div>
      )}

      {/* Live preview player */}
      {hls_available && token && (
        <PreviewPanel token={token} />
      )}
    </div>
  )
}
