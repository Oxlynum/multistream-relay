'use client'

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { secondsRemaining, formatDuration } from '@/lib/billing'

interface GpuStatus {
  status: string
  credits: number
  burn_rate: number
}

// Live cost meter: polls GPU status while a stream is running and shows the
// current burn rate ($/hr + tokens/hr) and time remaining at that rate.
export function CostMeter() {
  const [data, setData] = useState<GpuStatus | null>(null)

  useEffect(() => {
    let active = true
    async function poll() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const res = await fetch('/api/gpu/status', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => null)
      if (!res?.ok || !active) return
      setData(await res.json())
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { active = false; clearInterval(id) }
  }, [])

  const live = data?.status === 'running' && (data?.burn_rate ?? 0) > 0
  if (!live || !data) return null

  const tokensPerHr = data.burn_rate
  const dollarsPerHr = tokensPerHr * 2
  const remaining = secondsRemaining(data.credits, data.burn_rate)
  const lowRemaining = remaining < 1800

  return (
    <div className="bg-surface border border-success/30 rounded-2xl p-5 flex items-center justify-between shadow-glow">
      <div className="flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-success" />
        </span>
        <div>
          <div className="text-sm font-semibold">Streaming now</div>
          <div className="text-xs text-ink-faint">
            ${dollarsPerHr.toFixed(2)}/hr · {tokensPerHr.toFixed(1)} token{tokensPerHr !== 1 ? 's' : ''}/hr
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className={`text-lg font-bold font-mono ${lowRemaining ? 'text-warning' : 'text-ink'}`}>
          {formatDuration(remaining)}
        </div>
        <div className="text-xs text-ink-faint">left at this rate</div>
      </div>
    </div>
  )
}
