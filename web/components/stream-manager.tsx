'use client'

import { useEffect, useRef, useState } from 'react'
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

const GPU_LABELS: Record<string, string> = {
  a4000: 'RTX A4000', a5000: 'RTX A5000', l4: 'L4',
  a40: 'A40', rtx3090: 'RTX 3090', rtxpro4000: 'RTX PRO 4000',
  rtx4090: 'RTX 4090', rtxpro4500: 'RTX PRO 4500',
  rtx6000ada: 'RTX 6000 Ada', l40s: 'L40S', rtx5090: 'RTX 5090',
}

// ── HLS Preview Player ─────────────────────────────────────────────────────────
interface HlsPlayerProps {
  authToken: string
  streaming: boolean
}

function HlsPlayer({ authToken, streaming }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<import('hls.js').default | null>(null)
  const [playerState, setPlayerState] = useState<'loading' | 'playing' | 'waiting' | 'error'>('waiting')
  const prevStreaming = useRef(false)

  useEffect(() => {
    if (!streaming) {
      setPlayerState('waiting')
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
      prevStreaming.current = false
      return
    }
    if (prevStreaming.current) return
    prevStreaming.current = true

    const video = videoRef.current
    if (!video) return
    let destroyed = false
    setPlayerState('loading')

    async function setup() {
      const Hls = (await import('hls.js')).default
      if (destroyed || !video) return

      if (Hls.isSupported()) {
        const hls = new Hls({
          maxBufferLength: 10,
          backBufferLength: 0,
          xhrSetup(xhr) {
            xhr.setRequestHeader('Authorization', `Bearer ${authToken}`)
          },
        })
        hlsRef.current = hls
        hls.loadSource('/api/gpu/hls/index.m3u8')
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {})
          setPlayerState('playing')
        })
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) {
            hls.destroy()
            hlsRef.current = null
            setPlayerState('error')
            setTimeout(() => { if (!destroyed) { prevStreaming.current = false; setup() } }, 4000)
          }
        })
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = `/api/gpu/hls/index.m3u8?token=${encodeURIComponent(authToken)}`
        video.play().catch(() => {})
        setPlayerState('playing')
        video.onerror = () => setPlayerState('error')
      } else {
        setPlayerState('error')
      }
    }

    setup()
    return () => {
      destroyed = true
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null }
    }
  }, [streaming, authToken])

  return (
    <div className="rounded-xl overflow-hidden bg-black aspect-video relative">
      <video ref={videoRef} muted playsInline controls className="w-full h-full object-contain" />
      {playerState === 'waiting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
          <span className="text-ink-faint/50 text-xs">Preview starts when OBS is live</span>
        </div>
      )}
      {playerState === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-ink-faint/60 text-xs">Loading preview…</span>
        </div>
      )}
      {playerState === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <span className="text-ink-faint/60 text-xs text-center">Preview unavailable — retrying…</span>
        </div>
      )}
    </div>
  )
}

// ── Platform tile ──────────────────────────────────────────────────────────────
function PlatformTile({ platform, state, active }: { platform: string; state: string | undefined; active: boolean }) {
  const isLive       = active && state === 'running'
  const isRestarting = active && state === 'restarting'
  const isError      = active && state === 'error'

  const dotColor = isLive ? '#37d67a' : isRestarting ? '#ffb020' : isError ? '#ff5470' : '#555e6e'
  const label    = isLive ? 'live' : isRestarting ? 'reconnecting' : isError ? 'error' : active ? 'connecting…' : 'idle'
  const labelCls = isLive ? 'text-accent' : isRestarting ? 'text-amber-400' : isError ? 'text-red-400' : 'text-ink-faint'

  return (
    <div className={`bg-base border rounded-xl px-3 py-2.5 ${isError ? 'border-red-900/60' : 'border-line'}`}>
      <div className="flex items-center gap-1.5 mb-0.5">
        <span style={{ color: dotColor }} className="text-[10px] leading-none">●</span>
        <span className="text-xs font-medium text-ink">{PLATFORM_LABELS[platform]}</span>
      </div>
      <div className={`text-xs ${labelCls}`}>{label}</div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export function StreamManager() {
  const [data, setData] = useState<GpuStatus | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [authToken, setAuthToken] = useState<string | null>(null)
  const streamStartRef = useRef<number | null>(null)
  const prevStreaming = useRef(false)

  useEffect(() => {
    let active = true

    async function poll() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session || !active) return
      if (!authToken) setAuthToken(session.access_token)

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
      if (!body.streaming) streamStartRef.current = null
      prevStreaming.current = body.streaming
    }

    poll()
    const pollId  = setInterval(poll, 5000)
    const tickId  = setInterval(() => {
      if (streamStartRef.current) setElapsed(Date.now() - streamStartRef.current)
    }, 1000)

    return () => { active = false; clearInterval(pollId); clearInterval(tickId) }
  }, [authToken])

  if (!data) return null

  const { status, streaming, burn_rate, credits_seconds, outputs, gpu_type,
          confirm_required, confirm_deadline, hls_available } = data

  const states          = platformStateMap(outputs)
  const activePlatforms = PLATFORM_ORDER.filter(p => p in states)
  const allPlatforms    = PLATFORM_ORDER  // always show all 4 when pod is running
  const remaining       = secondsRemaining(credits_seconds, burn_rate)
  const lowCredits      = remaining < 1800 && streaming
  const confirmMsLeft   = confirm_deadline ? Math.max(0, new Date(confirm_deadline).getTime() - Date.now()) : null
  const confirmMinLeft  = confirmMsLeft !== null ? Math.floor(confirmMsLeft / 60000) : null

  // ── Idle ────────────────────────────────────────────────────────────────────
  if (status === 'stopped') {
    return (
      <div className="bg-surface border border-line rounded-2xl p-6 flex items-start gap-3">
        <span className="mt-1 h-2 w-2 rounded-full bg-ink-faint/30 flex-shrink-0" />
        <div>
          <div className="text-sm font-semibold text-ink-muted mb-1">Idle — not streaming</div>
          <div className="text-xs text-ink-faint">
            Press Go Live in OBS to start. Your GPU spins up automatically (~45 s).
          </div>
        </div>
      </div>
    )
  }

  // ── Spinning up ─────────────────────────────────────────────────────────────
  if (status === 'provisioning') {
    return (
      <div className="bg-surface border border-amber-800/40 rounded-2xl p-6 flex items-start gap-3">
        <span className="relative mt-1 flex h-2.5 w-2.5 flex-shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
        </span>
        <div>
          <div className="text-sm font-semibold text-amber-400 mb-1">Spinning up server…</div>
          <div className="text-xs text-ink-faint">
            Finding the nearest GPU, booting your relay, and pulling the Docker image.
            Usually ready in under a minute.
          </div>
        </div>
      </div>
    )
  }

  // ── Server ready, waiting for OBS ────────────────────────────────────────────
  if (status === 'running' && !streaming) {
    return (
      <div className="bg-surface border border-amber-800/30 rounded-2xl p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60 animate-ping" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
          </span>
          <div>
            <div className="text-sm font-semibold text-amber-400">Server ready · waiting for OBS</div>
            <div className="text-xs text-ink-faint mt-0.5">
              GPU is online. Make sure OBS is set to H265 and click Go Live in the SlimCast panel.
            </div>
          </div>
        </div>

        {/* Platform tiles — idle while waiting */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {allPlatforms.map(p => (
            <PlatformTile key={p} platform={p} state={undefined} active={false} />
          ))}
        </div>

        {gpu_type && (
          <div className="text-xs text-ink-faint border-t border-line pt-3">
            <span className="font-medium text-ink-muted">{GPU_LABELS[gpu_type] ?? gpu_type.toUpperCase()}</span>
            <span className="mx-1.5 text-ink-faint/40">·</span>
            RunPod community
          </div>
        )}
      </div>
    )
  }

  // ── Live ─────────────────────────────────────────────────────────────────────
  const anyError      = outputs.some(o => o.state === 'error')
  const anyRestarting = outputs.some(o => o.state === 'restarting')
  const borderCls = lowCredits
    ? 'border-amber-800/60'
    : anyError ? 'border-red-900/40' : 'border-accent/30'

  return (
    <div className={`bg-surface border rounded-2xl p-6 space-y-5 ${borderCls}`}>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping
              ${anyError ? 'bg-red-400' : anyRestarting ? 'bg-amber-400' : 'bg-accent'}`} />
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full
              ${anyError ? 'bg-red-400' : anyRestarting ? 'bg-amber-400' : 'bg-accent'}`} />
          </span>
          <div>
            <div className={`text-sm font-semibold leading-none
              ${anyError ? 'text-red-400' : anyRestarting ? 'text-amber-400' : 'text-ink'}`}>
              {anyError ? 'Live · platform error' : anyRestarting ? 'Live · reconnecting…' : 'Live'}
            </div>
            {streamStartRef.current && (
              <div className="text-xs text-ink-faint font-mono mt-0.5">{fmtElapsed(elapsed)}</div>
            )}
          </div>
        </div>

        <div className="text-right flex-shrink-0">
          <div className={`text-base font-bold font-mono ${lowCredits ? 'text-amber-400' : 'text-ink'}`}>
            {formatTokens(credits_seconds)}
          </div>
          <div className="text-xs text-ink-faint">
            {burn_rate > 0
              ? `${burn_rate.toFixed(1)} tkn/hr · $${(burn_rate * 2).toFixed(2)}/hr`
              : 'remaining'}
          </div>
        </div>
      </div>

      {/* Live preview */}
      {hls_available && authToken && (
        <HlsPlayer authToken={authToken} streaming={streaming} />
      )}

      {/* Platform tiles — always show all 4 when live so user sees what's up */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {allPlatforms.map(p => (
          <PlatformTile key={p} platform={p} state={states[p]} active={p in states} />
        ))}
      </div>

      {/* GPU badge */}
      {gpu_type && (
        <div className="flex items-center gap-x-2 border-t border-line pt-4 text-xs text-ink-faint">
          <span className="font-medium text-ink-muted">{GPU_LABELS[gpu_type] ?? gpu_type.toUpperCase()}</span>
          <span className="text-ink-faint/40">·</span>
          <span>RunPod community</span>
        </div>
      )}

      {/* 12h confirm banner */}
      {confirm_required && confirmMinLeft !== null && (
        <div className="bg-amber-950/30 border border-amber-800/60 rounded-xl px-4 py-3 space-y-1">
          <div className="text-sm font-semibold text-amber-400">Still streaming?</div>
          <div className="text-xs text-amber-500/80">
            You&apos;ve been live 12 hours. This stream ends in {confirmMinLeft} min unless you tap
            <span className="text-amber-400"> Yes, keep streaming</span> in the OBS plugin.
          </div>
        </div>
      )}
    </div>
  )
}
