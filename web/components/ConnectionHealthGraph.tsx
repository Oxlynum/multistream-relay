'use client'

import { useEffect, useRef, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'

interface MetricPoint {
  recorded_at: string
  bitrate_kbps: number | null
  health_score: number | null
  dropped_frames: number
}

interface ChartPoint {
  t: string       // formatted time label
  ms: number      // epoch ms for sorting
  bitrate: number | null
  health: number | null
}

const PLATFORMS = ['twitch', 'kick', 'youtube', 'tiktok'] as const
const PLATFORM_LABELS: Record<string, string> = {
  twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', tiktok: 'TikTok',
}

type Mode = 'inbound' | typeof PLATFORMS[number]

function healthColor(score: number | null): string {
  if (score === null) return '#475569'
  if (score >= 80) return '#10b981'
  if (score >= 50) return '#f59e0b'
  return '#f43f5e'
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function toChartPoints(raw: MetricPoint[]): ChartPoint[] {
  return raw.map(p => ({
    t: fmtTime(p.recorded_at),
    ms: new Date(p.recorded_at).getTime(),
    bitrate: p.bitrate_kbps,
    health: p.health_score,
  }))
}

interface TooltipPayload {
  name: string
  value: number | null
  color: string
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) {
  if (!active || !payload?.length) return null
  const bitrate = payload.find(p => p.name === 'bitrate')?.value
  const health  = payload.find(p => p.name === 'health')?.value
  return (
    <div className="bg-elevated border border-line rounded-lg px-3 py-2 text-xs space-y-0.5">
      <div className="text-ink-faint font-mono mb-1">{label}</div>
      {bitrate !== null && bitrate !== undefined && (
        <div className="text-ink">Bitrate: <span className="font-mono font-medium">{bitrate.toLocaleString()} kbps</span></div>
      )}
      {health !== null && health !== undefined && (
        <div style={{ color: healthColor(health) }}>
          Health: <span className="font-mono font-medium">{health}%</span>
        </div>
      )}
    </div>
  )
}

export function ConnectionHealthGraph({ enabledPlatforms }: { enabledPlatforms?: string[] }) {
  const [mode, setMode] = useState<Mode>('inbound')
  const [points, setPoints] = useState<ChartPoint[]>([])
  const [loading, setLoading] = useState(true)
  const tokenRef = useRef<string | null>(null)

  // Resolve auth token once
  useEffect(() => {
    async function loadToken() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      tokenRef.current = session?.access_token ?? null
    }
    loadToken()
  }, [])

  useEffect(() => {
    let active = true

    async function fetchMetrics() {
      const token = tokenRef.current
      if (!token) return

      const direction = mode === 'inbound' ? 'inbound' : 'outbound'
      const platform  = mode !== 'inbound' ? `&platform=${mode}` : ''
      const res = await fetch(`/api/metrics/connection?direction=${direction}${platform}&window=60`, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null)

      if (!res?.ok || !active) return
      const { points: raw } = await res.json() as { points: MetricPoint[] }
      if (active) {
        setPoints(toChartPoints(raw))
        setLoading(false)
      }
    }

    fetchMetrics()
    const id = setInterval(fetchMetrics, 5000)
    return () => { active = false; clearInterval(id) }
  }, [mode])

  const latestHealth = points.length > 0 ? points[points.length - 1].health : null
  const dotColor = healthColor(latestHealth)

  // Platforms to show in dropdown: inbound always first, then enabled platforms
  const outboundOptions = enabledPlatforms?.length
    ? enabledPlatforms.filter(p => PLATFORMS.includes(p as typeof PLATFORMS[number]))
    : Array.from(PLATFORMS)

  const isEmpty = !loading && points.length === 0

  return (
    <div className="bg-surface border border-line rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: latestHealth !== null ? dotColor : '#475569' }}
          />
          <span className="text-sm font-semibold text-ink">Connection</span>
        </div>

        <select
          value={mode}
          onChange={e => setMode(e.target.value as Mode)}
          className="text-xs bg-elevated border border-line text-ink-muted rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-accent cursor-pointer"
        >
          <option value="inbound">OBS → SlimCast</option>
          {outboundOptions.map(p => (
            <option key={p} value={p}>→ {PLATFORM_LABELS[p] ?? p}</option>
          ))}
        </select>
      </div>

      {/* Chart or empty state */}
      {isEmpty ? (
        <div className="flex flex-col items-center justify-center h-36 gap-2">
          <span
            className="h-2 w-2 rounded-full animate-pulse"
            style={{ backgroundColor: '#475569' }}
          />
          <span className="text-xs text-ink-faint">Start streaming to see connection health</span>
        </div>
      ) : (
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(30,41,59,0.8)" vertical={false} />
              <XAxis
                dataKey="t"
                tick={{ fontSize: 10, fill: '#475569', fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={60}
              />
              {/* Left Y: bitrate kbps */}
              <YAxis
                yAxisId="bitrate"
                orientation="left"
                tick={{ fontSize: 10, fill: '#475569' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => `${Math.round(v / 1000)}k`}
                width={32}
              />
              {/* Right Y: health % */}
              <YAxis
                yAxisId="health"
                orientation="right"
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: '#475569' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => `${v}%`}
                width={32}
              />
              <Tooltip content={<CustomTooltip />} />
              <Line
                yAxisId="bitrate"
                type="monotone"
                dataKey="bitrate"
                name="bitrate"
                stroke="#3b82f6"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3, fill: '#3b82f6' }}
                connectNulls
              />
              <Line
                yAxisId="health"
                type="monotone"
                dataKey="health"
                name="health"
                stroke={dotColor}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3, fill: dotColor }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Legend */}
      {!isEmpty && (
        <div className="flex items-center gap-4 text-xs text-ink-faint pt-1 border-t border-line">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-0.5 rounded bg-blue-500" />
            kbps
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: dotColor }} />
            health %
          </span>
          {latestHealth !== null && (
            <span className="ml-auto font-mono" style={{ color: dotColor }}>
              {latestHealth}%
            </span>
          )}
        </div>
      )}
    </div>
  )
}
