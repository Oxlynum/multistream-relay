'use client'

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { DashboardNav } from '@/components/dashboard-nav'
import { StreamManager } from '@/components/stream-manager'
import { ConnectionHealthGraph } from '@/components/ConnectionHealthGraph'
import { Kicker } from '@/components/ui/kicker'

export default function StreamPage() {
  const [enabledPlatforms, setEnabledPlatforms] = useState<string[]>([])

  useEffect(() => {
    async function loadPlatforms() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const res = await fetch('/api/platforms', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => null)
      if (!res?.ok) return
      const body = await res.json() as { platforms: Array<{ platform: string; enabled: boolean }> }
      setEnabledPlatforms(
        (body.platforms ?? []).filter(p => p.enabled).map(p => p.platform)
      )
    }
    loadPlatforms()
  }, [])

  return (
    <div className="min-h-screen">
      <DashboardNav />
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
        <div>
          <Kicker color="cyan">Control room</Kicker>
          <h1 className="mt-3 font-pixel text-lg text-ink">On Air</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Start streaming from OBS — SlimCast spins up a GPU and goes live automatically.
          </p>
        </div>
        <StreamManager />
        <ConnectionHealthGraph enabledPlatforms={enabledPlatforms} />
      </main>
    </div>
  )
}
