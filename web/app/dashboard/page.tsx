'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

interface GpuInstance {
  status: string
  ip_address: string | null
  last_seen_at: string | null
}

interface AgentOutput {
  name: string
  state: string
}

interface DashboardData {
  credits_seconds: number
  gpu: GpuInstance | null
  platforms: string[]
  api_key_exists: boolean
}

const PLATFORM_LABELS: Record<string, string> = {
  twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', tiktok: 'TikTok', facebook: 'Facebook',
}

function creditsFormatted(seconds: number) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function gpuStatusColor(status: string) {
  if (status === 'running') return 'bg-green-500'
  if (status === 'provisioning') return 'bg-yellow-500'
  return 'bg-gray-500'
}

function gpuStatusLabel(status: string) {
  if (status === 'running') return 'Online'
  if (status === 'provisioning') return 'Starting…'
  return 'Offline'
}

export default function DashboardPage() {
  const router = useRouter()
  const [data, setData] = useState<DashboardData | null>(null)
  const [outputs, setOutputs] = useState<AgentOutput[]>([])
  const [loading, setLoading] = useState(true)
  const [gpuLoading, setGpuLoading] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }

      const token = session.access_token
      const headers = { Authorization: `Bearer ${token}` }

      const [profileRes, gpuRes, platformRes, keyRes] = await Promise.all([
        fetch('/api/credits/balance', { headers }),
        supabase.from('gpu_instances').select('status, ip_address, last_seen_at').eq('user_id', session.user.id).maybeSingle(),
        supabase.from('platform_connections').select('platform').eq('user_id', session.user.id),
        fetch('/api/apikey', { headers }),
      ])

      const credits = await profileRes.json().catch(() => ({ seconds: 0 }))
      const keyData = await keyRes.json().catch(() => ({ exists: false }))

      setData({
        credits_seconds: credits.seconds ?? 0,
        gpu: gpuRes.data ?? null,
        platforms: (platformRes.data ?? []).map((p: { platform: string }) => p.platform),
        api_key_exists: keyData.exists ?? false,
      })
    } catch (err) {
      console.error('Dashboard load failed:', err)
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => { load() }, [load])

  // Poll agent status if GPU is running
  useEffect(() => {
    if (!data?.gpu || data.gpu.status !== 'running') return
    const interval = setInterval(async () => {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const res = await fetch('/api/agent/status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputs, streaming: outputs.some(o => o.state === 'running') }),
      }).catch(() => null)
      if (res?.ok) {
        const body = await res.json()
        if (body.outputs) setOutputs(body.outputs)
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [data?.gpu, outputs])

  async function provisionGpu() {
    setGpuLoading(true)
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    await fetch('/api/gpu/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    await load()
    setGpuLoading(false)
  }

  async function stopGpu() {
    setGpuLoading(true)
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    await fetch('/api/gpu/stop', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    await load()
    setGpuLoading(false)
  }

  async function generateApiKey() {
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return
    const res = await fetch('/api/apikey', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    const body = await res.json()
    setApiKey(body.api_key)
    await load()
  }

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  async function signOut() {
    const supabase = createBrowserClient()
    await supabase.auth.signOut()
    router.push('/')
  }

  if (loading) {
    return <main className="min-h-screen bg-gray-950 text-white flex items-center justify-center text-gray-500">Loading…</main>
  }

  const gpu = data?.gpu
  const creditsLow = (data?.credits_seconds ?? 0) < 1800
  const rtmpUrl = gpu?.ip_address ? `rtmp://${gpu.ip_address}:1935/live` : null

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-8 py-5 border-b border-gray-800">
        <span className="text-xl font-bold tracking-tight">SlimCast</span>
        <div className="flex items-center gap-6 text-sm">
          <a href="/dashboard/platforms" className="text-gray-400 hover:text-white transition-colors">Platforms</a>
          <a href="/dashboard/settings" className="text-gray-400 hover:text-white transition-colors">Settings</a>
          <a href="/dashboard/credits" className="text-gray-400 hover:text-white transition-colors">Credits</a>
          <button onClick={signOut} className="text-gray-400 hover:text-white transition-colors">Sign out</button>
        </div>
      </nav>

      <div className="max-w-3xl mx-auto px-6 py-10 space-y-5">

        {/* Credits */}
        <div className={`border rounded-2xl p-6 flex items-center justify-between ${creditsLow ? 'bg-amber-950/30 border-amber-800' : 'bg-gray-900 border-gray-800'}`}>
          <div>
            <div className="text-sm text-gray-400 mb-1">Streaming credits</div>
            <div className={`text-3xl font-bold ${creditsLow ? 'text-amber-400' : 'text-white'}`}>
              {creditsFormatted(data?.credits_seconds ?? 0)}
            </div>
            {creditsLow && <div className="text-sm text-amber-500 mt-1">Less than 30 minutes remaining</div>}
          </div>
          <a href="/dashboard/credits" className="bg-blue-600 hover:bg-blue-500 px-5 py-2 rounded-lg text-sm font-semibold transition-colors">
            Buy Credits
          </a>
        </div>

        {/* GPU */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm text-gray-400">GPU</div>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${gpuStatusColor(gpu?.status ?? 'stopped')}`} />
              <span className="text-sm">{gpuStatusLabel(gpu?.status ?? 'stopped')}</span>
            </div>
          </div>
          {gpu?.status === 'running' && gpu.ip_address && (
            <div className="mb-4 space-y-2">
              <div className="text-xs text-gray-500">OBS stream URL</div>
              <div className="flex items-center gap-3">
                <code className="flex-1 bg-gray-800 rounded-lg px-3 py-2 text-sm font-mono text-gray-300">
                  {rtmpUrl}
                </code>
                <button
                  onClick={() => copy(rtmpUrl!, 'rtmp')}
                  className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-lg text-sm transition-colors min-w-[60px]"
                >
                  {copied === 'rtmp' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}
          <div className="flex gap-3">
            {(!gpu || gpu.status === 'stopped') && (
              <button
                onClick={provisionGpu}
                disabled={gpuLoading}
                className="bg-green-700 hover:bg-green-600 disabled:opacity-50 px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
              >
                {gpuLoading ? 'Launching…' : 'Launch GPU'}
              </button>
            )}
            {gpu?.status === 'running' && (
              <button
                onClick={stopGpu}
                disabled={gpuLoading}
                className="bg-gray-700 hover:bg-gray-600 disabled:opacity-50 px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
              >
                {gpuLoading ? 'Stopping…' : 'Stop GPU'}
              </button>
            )}
            {gpu?.status === 'provisioning' && (
              <div className="text-sm text-yellow-400 py-2">Starting up (~45 seconds)…</div>
            )}
          </div>
        </div>

        {/* Stream status */}
        {gpu?.status === 'running' && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <div className="text-sm text-gray-400 mb-4">Platforms</div>
            {data?.platforms.length === 0 ? (
              <p className="text-sm text-gray-500">
                No platforms connected. <a href="/dashboard/platforms" className="text-blue-400 hover:text-blue-300">Add platforms →</a>
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {data?.platforms.map(p => {
                  const output = outputs.find(o => o.name === p)
                  const live = output?.state === 'running'
                  return (
                    <div key={p} className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${live ? 'bg-green-500' : 'bg-gray-600'}`} />
                      <span className="text-sm">{PLATFORM_LABELS[p] ?? p}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* API Key */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="text-sm text-gray-400 mb-3">SlimCast API key</div>
          <div className="text-xs text-gray-500 mb-4">
            Enter this once in the OBS plugin. It authenticates your GPU and OBS dock.
          </div>
          {apiKey ? (
            <div className="space-y-3">
              <div className="bg-amber-950/40 border border-amber-800 rounded-lg px-3 py-2 text-xs text-amber-400">
                Save this key now — it won&apos;t be shown again.
              </div>
              <div className="flex items-center gap-3">
                <code className="flex-1 bg-gray-800 rounded-lg px-3 py-2 text-sm font-mono text-gray-300 break-all">
                  {apiKey}
                </code>
                <button
                  onClick={() => copy(apiKey, 'apikey')}
                  className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-lg text-sm transition-colors min-w-[60px]"
                >
                  {copied === 'apikey' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={generateApiKey}
              className="bg-gray-700 hover:bg-gray-600 px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
            >
              {data?.api_key_exists ? 'Regenerate API key' : 'Generate API key'}
            </button>
          )}
        </div>

      </div>
    </main>
  )
}
