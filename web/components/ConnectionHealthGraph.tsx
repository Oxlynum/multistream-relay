'use client'

import { useEffect, useRef, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

interface MetricPoint {
  recorded_at: string
  bitrate_kbps: number | null
  health_score: number | null
  dropped_frames: number | null
}

interface ChartPoint {
  t: string
  health: number | null
  bitrate: number | null
  dropped: number | null
}

const PLATFORMS = ['twitch', 'kick', 'youtube', 'tiktok'] as const
const PLATFORM_LABELS: Record<string, string> = {
  twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', tiktok: 'TikTok',
}

const LINE_COLOR = '#a3f000' // neon lime

function healthColor(score: number | null): string {
  if (score === null) return '#4d5f33'
  if (score >= 80) return '#a3f000' // lime = good
  if (score >= 50) return '#ffb400' // amber
  return '#ff414d'                  // red
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean
  payload?: Array<{ payload?: ChartPoint }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  const pt = payload[0]?.payload
  return (
    <div className="bg-surface-2 border-2 border-line px-3 py-2 text-xs space-y-1">
      <div className="text-ink-faint font-mono mb-1">{label}</div>
      {pt?.health !== null && pt?.health !== undefined && (
        <div style={{ color: healthColor(pt.health) }}>
          Health: <span className="font-mono font-medium">{pt.health}%</span>
        </div>
      )}
      {pt?.bitrate !== null && pt?.bitrate !== undefined && (
        <div className="text-ink-muted">
          Bitrate: <span className="font-mono font-medium">{pt.bitrate} kbps</span>
        </div>
      )}
      {!!pt?.dropped && pt.dropped > 0 && (
        <div className="text-warning">
          Dropped: <span className="font-mono font-medium">{pt.dropped}</span>
        </div>
      )}
    </div>
  )
}

export function ConnectionHealthGraph({ enabledPlatforms }: { enabledPlatforms?: string[] }) {
  const platforms = enabledPlatforms?.length
    ? enabledPlatforms.filter(p => PLATFORMS.includes(p as typeof PLATFORMS[number]))
    : Array.from(PLATFORMS)

  const [selectedKey, setSelectedKey] = useState<string>('inbound')
  const [points, setPoints]           = useState<ChartPoint[]>([])
  const [loading, setLoading]         = useState(true)
  const tokenRef = useRef<string | null>(null)

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

      const url = selectedKey === 'inbound'
        ? '/api/metrics/connection?direction=inbound&window=60'
        : `/api/metrics/connection?direction=outbound&platform=${selectedKey}&window=60`

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null)

      if (!active || !res?.ok) return

      const { points: raw } = await res.json() as { points: MetricPoint[] }
      setPoints(raw.map(p => ({
        t:       fmtTime(p.recorded_at),
        health:  p.health_score,
        bitrate: p.bitrate_kbps,
        dropped: p.dropped_frames,
      })))
      setLoading(false)
    }

    setPoints([])
    setLoading(true)
    fetchMetrics()
    const id = setInterval(fetchMetrics, 5000)
    return () => { active = false; clearInterval(id) }
  }, [selectedKey])

  const latest   = points.length ? points[points.length - 1] : null
  const isEmpty  = !loading && points.length === 0
  const label    = selectedKey === 'inbound'
    ? '→ SlimCast'
    : `→ ${PLATFORM_LABELS[selectedKey] ?? selectedKey}`

  return (
    <div className="bg-surface border-2 border-line p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className="h-2 w-2 flex-shrink-0"
            style={{ backgroundColor: healthColor(latest?.health ?? null) }}
          />
          <span className="text-xs text-ink-faint">{label}</span>
          {latest?.health !== null && latest?.health !== undefined && (
            <span className="text-xs font-mono" style={{ color: healthColor(latest.health) }}>
              {latest.health}%
            </span>
          )}
          {latest?.bitrate !== null && latest?.bitrate !== undefined && (
            <span className="text-xs text-ink-faint/50 font-mono">· {latest.bitrate} kbps</span>
          )}
        </div>

        <Select value={selectedKey} onValueChange={(v) => setSelectedKey(v as string)}>
          <SelectTrigger size="sm" className="text-xs text-ink-muted">
            <SelectValue>
              {(v: string) => (v === 'inbound' ? '→ SlimCast' : `→ ${PLATFORM_LABELS[v] ?? v}`)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inbound">→ SlimCast</SelectItem>
            {platforms.map(p => (
              <SelectItem key={p} value={p}>→ {PLATFORM_LABELS[p] ?? p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Chart */}
      {isEmpty ? (
        <div className="flex flex-col items-center justify-center h-36 gap-2">
          <span className="h-2 w-2 animate-pulse bg-ink-faint/40" />
          <span className="text-xs text-ink-faint">Start streaming to see connection health</span>
        </div>
      ) : (
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(163,240,0,0.1)" vertical={false} />
              <XAxis
                dataKey="t"
                tick={{ fontSize: 10, fill: '#8fae6e', fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                minTickGap={60}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: '#8fae6e' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => `${v}%`}
                width={32}
              />
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey="health"
                name={label}
                stroke={LINE_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3, fill: LINE_COLOR }}
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
            <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: LINE_COLOR }} />
            {label}
          </span>
          <span className="ml-auto text-ink-faint/50">health score %</span>
        </div>
      )}
    </div>
  )
}
