'use client'

import { useEffect, useRef, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts'

interface MetricPoint {
  recorded_at: string
  health_score: number | null
}

interface ChartPoint {
  t: string
  ms: number
  inHealth: number | null    // OBS → SlimCast (always shown)
  outHealth: number | null   // selected platform (changeable)
}

const PLATFORMS = ['twitch', 'kick', 'youtube', 'tiktok'] as const
const PLATFORM_LABELS: Record<string, string> = {
  twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', tiktok: 'TikTok',
}

const INBOUND_COLOR  = '#3b82f6'   // blue — always OBS→SlimCast
const OUTBOUND_COLOR = '#10b981'   // green — selected platform

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

function toMs(iso: string): number { return new Date(iso).getTime() }

// Merge inbound and outbound point arrays onto a shared timeline.
// Points written in the same heartbeat are ≤1s apart — match within 6s.
function mergePoints(inRaw: MetricPoint[], outRaw: MetricPoint[]): ChartPoint[] {
  const MATCH_MS = 6000
  const out = outRaw.map(p => ({ ms: toMs(p.recorded_at), health: p.health_score }))

  return inRaw.map(p => {
    const ms = toMs(p.recorded_at)
    const match = out.find(o => Math.abs(o.ms - ms) <= MATCH_MS)
    return {
      t: fmtTime(p.recorded_at),
      ms,
      inHealth: p.health_score,
      outHealth: match?.health ?? null,
    }
  })
}

interface TooltipPayload { name: string; value: number | null; color: string }

function CustomTooltip({ active, payload, label }: {
  active?: boolean; payload?: TooltipPayload[]; label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-elevated border border-line rounded-lg px-3 py-2 text-xs space-y-1">
      <div className="text-ink-faint font-mono mb-1">{label}</div>
      {payload.map(p => p.value !== null && p.value !== undefined && (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: <span className="font-mono font-medium">{p.value}%</span>
        </div>
      ))}
    </div>
  )
}

export function ConnectionHealthGraph({ enabledPlatforms }: { enabledPlatforms?: string[] }) {
  const platforms = enabledPlatforms?.length
    ? enabledPlatforms.filter(p => PLATFORMS.includes(p as typeof PLATFORMS[number]))
    : Array.from(PLATFORMS)

  const [platform, setPlatform] = useState<string>(platforms[0] ?? 'twitch')
  const [points, setPoints]     = useState<ChartPoint[]>([])
  const [loading, setLoading]   = useState(true)
  const tokenRef = useRef<string | null>(null)

  // Keep platform in sync if enabledPlatforms changes
  useEffect(() => {
    if (platforms.length && !platforms.includes(platform)) {
      setPlatform(platforms[0])
    }
  }, [platforms.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

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

      const base = `/api/metrics/connection?window=60`
      const [inRes, outRes] = await Promise.all([
        fetch(`${base}&direction=inbound`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
        fetch(`${base}&direction=outbound&platform=${platform}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
      ])

      if (!active) return

      const inData  = inRes?.ok  ? (await inRes.json()  as { points: MetricPoint[] }).points  : []
      const outData = outRes?.ok ? (await outRes.json() as { points: MetricPoint[] }).points : []

      setPoints(mergePoints(inData, outData))
      setLoading(false)
    }

    fetchMetrics()
    const id = setInterval(fetchMetrics, 5000)
    return () => { active = false; clearInterval(id) }
  }, [platform])

  const latestIn  = points.length ? points[points.length - 1].inHealth  : null
  const latestOut = points.length ? points[points.length - 1].outHealth : null
  const isEmpty   = !loading && points.length === 0

  return (
    <div className="bg-surface border border-line rounded-2xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* OBS→SlimCast health dot — always visible */}
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: latestIn !== null ? healthColor(latestIn) : '#475569' }} />
            <span className="text-xs text-ink-faint">OBS → SlimCast</span>
          </div>
          {latestOut !== null && (
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: healthColor(latestOut) }} />
              <span className="text-xs text-ink-faint">→ {PLATFORM_LABELS[platform] ?? platform}</span>
            </div>
          )}
        </div>

        {/* Platform picker — only controls the second line */}
        <select
          value={platform}
          onChange={e => setPlatform(e.target.value)}
          className="text-xs bg-elevated border border-line text-ink-muted rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-accent cursor-pointer"
        >
          {platforms.map(p => (
            <option key={p} value={p}>→ {PLATFORM_LABELS[p] ?? p}</option>
          ))}
        </select>
      </div>

      {/* Chart */}
      {isEmpty ? (
        <div className="flex flex-col items-center justify-center h-36 gap-2">
          <span className="h-2 w-2 rounded-full animate-pulse bg-ink-faint/40" />
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
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: '#475569' }}
                tickLine={false}
                axisLine={false}
                tickFormatter={v => `${v}%`}
                width={32}
              />
              <Tooltip content={<CustomTooltip />} />
              {/* Always-on: OBS → SlimCast inbound health */}
              <Line
                type="monotone"
                dataKey="inHealth"
                name="OBS → SlimCast"
                stroke={INBOUND_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3, fill: INBOUND_COLOR }}
                connectNulls
              />
              {/* Platform line — changes with dropdown */}
              <Line
                type="monotone"
                dataKey="outHealth"
                name={`→ ${PLATFORM_LABELS[platform] ?? platform}`}
                stroke={OUTBOUND_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3, fill: OUTBOUND_COLOR }}
                connectNulls
                strokeDasharray="4 2"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Legend */}
      {!isEmpty && (
        <div className="flex items-center gap-4 text-xs text-ink-faint pt-1 border-t border-line">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-0.5 rounded" style={{ backgroundColor: INBOUND_COLOR }} />
            OBS → SlimCast
          </span>
          <span className="flex items-center gap-1.5">
            {/* dashed to match the Line strokeDasharray */}
            <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: OUTBOUND_COLOR }} />
            → {PLATFORM_LABELS[platform] ?? platform}
          </span>
          {latestIn !== null && (
            <span className="ml-auto font-mono" style={{ color: healthColor(latestIn) }}>
              {latestIn}%
            </span>
          )}
        </div>
      )}
    </div>
  )
}
