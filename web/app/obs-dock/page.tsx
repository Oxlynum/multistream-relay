'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

interface PlatformStatus {
  name: string
  state: string
}

interface DockState {
  outputs: PlatformStatus[]
  credits_seconds: number
  command: string | null
}

const LABELS: Record<string, string> = {
  twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook',
}

function fmtCredits(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function ObsDockInner() {
  const searchParams = useSearchParams()
  const apiKey = searchParams.get('key')

  const [state, setState] = useState<DockState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [controlling, setControlling] = useState(false)

  const headers: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    : {}

  const poll = useCallback(async () => {
    if (!apiKey) return
    const isStreaming = state?.outputs.some(o => o.state === 'running') ?? false

    const res = await fetch('/api/agent/status', {
      method: 'POST',
      headers,
      body: JSON.stringify({ outputs: state?.outputs ?? [], streaming: isStreaming }),
    }).catch(() => null)

    if (!res?.ok) {
      setError('Connection lost')
      return
    }
    const body: DockState = await res.json()
    setState(body)
    setError(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, state?.outputs])

  useEffect(() => {
    if (!apiKey) { setError('No API key — open this dock via SlimCast dashboard.'); return }
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey])

  async function sendCommand(command: 'start' | 'stop') {
    if (!apiKey) return
    setControlling(true)
    await fetch('/api/agent/control', {
      method: 'POST',
      headers,
      body: JSON.stringify({ command }),
    }).catch(() => null)
    setControlling(false)
  }

  const isLive = state?.outputs.some(o => o.state === 'running') ?? false
  const creditsLow = (state?.credits_seconds ?? Infinity) < 1800

  return (
    <main className="min-h-screen bg-gray-950 text-white text-sm p-3 select-none">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="font-bold text-base tracking-tight">SlimCast</span>
        <div className={`flex items-center gap-1.5 text-xs ${isLive ? 'text-green-400' : 'text-gray-500'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-green-500' : 'bg-gray-600'}`} />
          {isLive ? 'Live' : 'Offline'}
        </div>
      </div>

      {error && (
        <div className="bg-red-950/60 border border-red-800 rounded-lg px-3 py-2 text-xs text-red-400 mb-3">
          {error}
        </div>
      )}

      {/* Credits */}
      {state && (
        <div className={`rounded-lg px-3 py-2 mb-3 text-xs flex justify-between ${creditsLow ? 'bg-amber-950/40 text-amber-400' : 'bg-gray-900 text-gray-400'}`}>
          <span>Credits</span>
          <span className="font-mono font-semibold">{fmtCredits(state.credits_seconds)}</span>
        </div>
      )}

      {creditsLow && (
        <a
          href="https://slimcast.com/dashboard/credits"
          target="_blank"
          rel="noreferrer"
          className="block text-center text-xs text-amber-400 hover:text-amber-300 bg-amber-950/30 border border-amber-800 rounded-lg py-2 mb-3 transition-colors"
        >
          Buy credits →
        </a>
      )}

      {/* Platform dots */}
      {state?.outputs && state.outputs.length > 0 && (
        <div className="bg-gray-900 rounded-lg px-3 py-2.5 mb-3 grid grid-cols-2 gap-y-1.5 gap-x-3">
          {state.outputs.map(o => (
            <div key={o.name} className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${o.state === 'running' ? 'bg-green-500' : 'bg-gray-600'}`} />
              <span className="text-xs text-gray-300">{LABELS[o.name] ?? o.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="flex gap-2">
        <button
          onClick={() => sendCommand('start')}
          disabled={controlling || isLive}
          className="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-30 py-2 rounded-lg text-xs font-semibold transition-colors"
        >
          Start
        </button>
        <button
          onClick={() => sendCommand('stop')}
          disabled={controlling || !isLive}
          className="flex-1 bg-red-800 hover:bg-red-700 disabled:opacity-30 py-2 rounded-lg text-xs font-semibold transition-colors"
        >
          Stop
        </button>
      </div>

      <p className="text-center text-gray-700 text-xs mt-3">
        OBS auto-starts when you click Start Streaming
      </p>
    </main>
  )
}

export default function ObsDockPage() {
  return (
    <Suspense>
      <ObsDockInner />
    </Suspense>
  )
}
