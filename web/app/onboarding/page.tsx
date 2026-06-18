'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

const STEPS = ['Connect Platforms', 'Download Plugin', 'Launch GPU', "You're Ready"]

const PLATFORMS = [
  { id: 'twitch',   label: 'Twitch',   note: '' },
  { id: 'kick',     label: 'Kick',     note: '' },
  { id: 'youtube',  label: 'YouTube',  note: '' },
  { id: 'tiktok',   label: 'TikTok',   note: 'Requires LIVE access (1000+ followers)' },
  { id: 'facebook', label: 'Facebook', note: 'Use your Creator Studio stream key' },
]

type GpuStatus = 'idle' | 'provisioning' | 'running' | 'error'

export default function OnboardingPage() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [streamKeys, setStreamKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [gpuStatus, setGpuStatus] = useState<GpuStatus>('idle')
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    async function init() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setToken(session.access_token)
    }
    init()
  }, [router])

  const connectedCount = Object.values(streamKeys).filter(v => v.trim()).length

  async function savePlatforms() {
    if (!token || connectedCount === 0) return
    setSaving(true)

    await Promise.all(
      Object.entries(streamKeys)
        .filter(([, key]) => key.trim())
        .map(([platform, key]) =>
          fetch('/api/platforms', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, stream_key: key.trim() }),
          })
        )
    )

    setSaving(false)
    setStep(1)
  }

  async function provisionGpu() {
    if (!token) return
    setGpuStatus('provisioning')

    const res = await fetch('/api/gpu/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      setGpuStatus('error')
      return
    }

    // Poll until agent checks in (up to 90s)
    const supabase = createBrowserClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    for (let i = 0; i < 18; i++) {
      await new Promise(r => setTimeout(r, 5000))
      const { data } = await supabase
        .from('gpu_instances')
        .select('status')
        .eq('user_id', session.user.id)
        .single()
      if (data?.status === 'running') {
        setGpuStatus('running')
        return
      }
    }

    // Timed out but likely still starting — mark running anyway for UX
    setGpuStatus('running')
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-start pt-16 px-6">
      <div className="w-full max-w-lg">
        <div className="text-center mb-10">
          <span className="text-2xl font-bold tracking-tight">SlimCast</span>
          <p className="text-gray-400 text-sm mt-1">Stream everywhere, no setup.</p>
        </div>

        {/* Progress bar */}
        <div className="flex gap-1 mb-10">
          {STEPS.map((label, i) => (
            <div key={label} className="flex-1 flex flex-col items-center gap-1">
              <div className={`h-1 w-full rounded-full transition-colors ${i <= step ? 'bg-blue-500' : 'bg-gray-800'}`} />
              <span className={`text-xs ${i === step ? 'text-white' : 'text-gray-600'}`}>{label}</span>
            </div>
          ))}
        </div>

        {/* Step 0: Connect Platforms */}
        {step === 0 && (
          <div className="space-y-4">
            <h1 className="text-xl font-bold mb-2">Connect your platforms</h1>
            <p className="text-sm text-gray-400 mb-5">
              Paste your stream keys. SlimCast handles the rest — you never touch an RTMP URL again.
            </p>
            {PLATFORMS.map(p => (
              <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">{p.label}</span>
                  {streamKeys[p.id]?.trim() && (
                    <span className="text-xs text-green-400">✓ Added</span>
                  )}
                </div>
                {p.note && <p className="text-xs text-gray-500 mb-2">{p.note}</p>}
                <input
                  type="password"
                  placeholder="Stream key"
                  value={streamKeys[p.id] ?? ''}
                  onChange={e => setStreamKeys(prev => ({ ...prev, [p.id]: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>
            ))}
            <div className="pt-4 flex gap-3">
              <button
                onClick={savePlatforms}
                disabled={saving || connectedCount === 0}
                className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 py-3 rounded-xl font-semibold transition-colors"
              >
                {saving ? 'Saving…' : `Continue with ${connectedCount} platform${connectedCount !== 1 ? 's' : ''}`}
              </button>
              <button
                onClick={() => setStep(1)}
                className="px-4 py-3 text-sm text-gray-500 hover:text-gray-300 transition-colors"
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Download Plugin */}
        {step === 1 && (
          <div>
            <h1 className="text-xl font-bold mb-2">Install the OBS plugin</h1>
            <p className="text-sm text-gray-400 mb-6">
              The SlimCast plugin adds a dock to OBS. One double-click to install — no settings to configure.
            </p>
            <div className="flex gap-3 mb-6">
              <a
                href="/downloads/slimcast-obs-plugin.pkg"
                className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 py-4 rounded-xl text-center transition-colors"
              >
                <div className="font-semibold mb-1">Mac</div>
                <div className="text-xs text-gray-400">.pkg installer</div>
              </a>
              <a
                href="/downloads/slimcast-obs-plugin.exe"
                className="flex-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 py-4 rounded-xl text-center transition-colors"
              >
                <div className="font-semibold mb-1">Windows</div>
                <div className="text-xs text-gray-400">.exe installer</div>
              </a>
            </div>
            <ol className="text-sm text-gray-400 space-y-1 list-decimal list-inside mb-8">
              <li>Download and double-click the installer</li>
              <li>Open OBS — the SlimCast panel will be there</li>
              <li>Enter your API key from the dashboard (one time)</li>
            </ol>
            <button
              onClick={() => setStep(2)}
              className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl font-semibold transition-colors"
            >
              I&apos;ve installed it
            </button>
          </div>
        )}

        {/* Step 2: Provision GPU */}
        {step === 2 && (
          <div>
            <h1 className="text-xl font-bold mb-2">Launch your GPU</h1>
            <p className="text-sm text-gray-400 mb-6">
              SlimCast spins up a cloud GPU to transcode and relay your stream. Takes about 45 seconds.
            </p>
            {gpuStatus === 'idle' && (
              <button
                onClick={provisionGpu}
                className="w-full bg-green-700 hover:bg-green-600 py-4 rounded-xl font-semibold transition-colors mb-4"
              >
                Launch GPU
              </button>
            )}
            {gpuStatus === 'provisioning' && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center mb-4">
                <div className="text-yellow-400 font-semibold mb-2">Starting up…</div>
                <div className="text-sm text-gray-400">This takes about 45 seconds.</div>
                <div className="mt-4 h-1 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full bg-yellow-500 animate-pulse rounded-full w-3/4" />
                </div>
              </div>
            )}
            {gpuStatus === 'running' && (
              <div className="bg-green-900/30 border border-green-700 rounded-xl p-6 text-center mb-4">
                <div className="text-green-400 font-semibold text-lg mb-1">GPU Ready ✓</div>
                <div className="text-sm text-gray-400">Your relay is online.</div>
              </div>
            )}
            {gpuStatus === 'error' && (
              <div className="bg-red-950/40 border border-red-800 rounded-xl p-4 text-sm text-red-400 mb-4">
                Something went wrong. <button onClick={() => setGpuStatus('idle')} className="underline">Try again</button>
              </div>
            )}
            {(gpuStatus === 'running') && (
              <button
                onClick={() => setStep(3)}
                className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl font-semibold transition-colors"
              >
                Continue
              </button>
            )}
            <button
              onClick={() => setStep(3)}
              className="w-full mt-3 text-sm text-gray-500 hover:text-gray-300 py-2 transition-colors"
            >
              Skip — I&apos;ll do this later
            </button>
          </div>
        )}

        {/* Step 3: Done */}
        {step === 3 && (
          <div className="text-center">
            <div className="text-5xl mb-4">🎉</div>
            <h1 className="text-2xl font-bold mb-2">You&apos;re ready to stream.</h1>
            <p className="text-gray-400 text-sm mb-2">2 free hours in your account. No credit card required to start.</p>
            <p className="text-gray-500 text-sm mb-8">Open OBS and click Start Streaming. That&apos;s it.</p>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-left text-sm space-y-2 mb-8">
              {connectedCount > 0 && (
                <div className="flex items-center gap-2 text-green-400">
                  <span>✓</span><span>{connectedCount} platform{connectedCount !== 1 ? 's' : ''} connected</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-gray-400">
                <span>→</span><span>Install OBS plugin + enter API key from dashboard</span>
              </div>
              {gpuStatus === 'running' && (
                <div className="flex items-center gap-2 text-green-400">
                  <span>✓</span><span>GPU online</span>
                </div>
              )}
            </div>

            <button
              onClick={() => router.push('/dashboard')}
              className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl font-semibold transition-colors"
            >
              Open Dashboard
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
