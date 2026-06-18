'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

const STEPS = ['Connect Platforms', 'Your API Key', 'Install Plugin', "You're Ready"]

const PLATFORMS = [
  { id: 'twitch',   label: 'Twitch',   note: '' },
  { id: 'kick',     label: 'Kick',     note: '' },
  { id: 'youtube',  label: 'YouTube',  note: '' },
  { id: 'tiktok',   label: 'TikTok',   note: 'Requires LIVE access (1000+ followers)' },
  { id: 'facebook', label: 'Facebook', note: 'Use your Creator Studio stream key' },
]

export default function OnboardingPage() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [streamKeys, setStreamKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [apiKeyCopied, setApiKeyCopied] = useState(false)
  const [apiKeyLoading, setApiKeyLoading] = useState(false)

  useEffect(() => {
    async function init() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setToken(session.access_token)
    }
    init()
  }, [router])

  const generateKey = useCallback(async (tok: string) => {
    setApiKeyLoading(true)
    try {
      const res = await fetch('/api/apikey', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}` },
      })
      const body = await res.json()
      setApiKey(body.api_key)
    } finally {
      setApiKeyLoading(false)
    }
  }, [])

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
    goToApiKeyStep()
  }

  function goToApiKeyStep() {
    setStep(1)
    if (token && !apiKey) generateKey(token)
  }

  function copyKey() {
    if (!apiKey) return
    navigator.clipboard.writeText(apiKey)
    setApiKeyCopied(true)
    setTimeout(() => setApiKeyCopied(false), 2000)
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-start pt-16 px-6">
      <div className="w-full max-w-lg">
        <div className="text-center mb-10">
          <span className="text-2xl font-bold tracking-tight">SlimCast</span>
          <p className="text-gray-400 text-sm mt-1">Stream everywhere, no setup.</p>
        </div>

        {/* Progress */}
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
                onClick={() => goToApiKeyStep()}
                className="px-4 py-3 text-sm text-gray-500 hover:text-gray-300 transition-colors"
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {/* Step 1: API Key */}
        {step === 1 && (
          <div>
            <h1 className="text-xl font-bold mb-2">Your API key</h1>
            <p className="text-sm text-gray-400 mb-6">
              This key links your OBS plugin to your SlimCast account. Enter it once in the SlimCast panel inside OBS — you&apos;re never asked again.
            </p>

            {apiKeyLoading && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center text-gray-500 text-sm mb-4">
                Generating your key…
              </div>
            )}

            {apiKey && (
              <div className="space-y-3 mb-6">
                <div className="bg-amber-950/40 border border-amber-800 rounded-xl px-4 py-3 text-sm text-amber-400">
                  Copy this key now — it won&apos;t be shown again.
                </div>
                <div className="flex items-center gap-3">
                  <code className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm font-mono text-gray-200 break-all">
                    {apiKey}
                  </code>
                  <button
                    onClick={copyKey}
                    className={`px-4 py-3 rounded-xl text-sm font-semibold transition-colors min-w-[80px] ${
                      apiKeyCopied
                        ? 'bg-green-700 text-white'
                        : 'bg-blue-600 hover:bg-blue-500 text-white'
                    }`}
                  >
                    {apiKeyCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-sm text-gray-400 space-y-2 mb-6">
              <p className="font-medium text-white text-xs uppercase tracking-wider mb-3">Where to paste it</p>
              <div className="flex gap-3">
                <span className="text-blue-400 font-bold shrink-0">1.</span>
                <span>Open OBS → look for the <strong className="text-white">SlimCast</strong> panel in your docks</span>
              </div>
              <div className="flex gap-3">
                <span className="text-blue-400 font-bold shrink-0">2.</span>
                <span>Click the <strong className="text-white">Account</strong> tab</span>
              </div>
              <div className="flex gap-3">
                <span className="text-blue-400 font-bold shrink-0">3.</span>
                <span>Paste your API key and click <strong className="text-white">Save</strong></span>
              </div>
            </div>

            <p className="text-xs text-gray-600 mb-6">
              Lost your key? You can generate a new one anytime from the dashboard. This will invalidate the old key.
            </p>

            <button
              onClick={() => setStep(2)}
              className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl font-semibold transition-colors"
            >
              I&apos;ve copied it — continue
            </button>
          </div>
        )}

        {/* Step 2: Install Plugin */}
        {step === 2 && (
          <div>
            <h1 className="text-xl font-bold mb-2">Install the OBS plugin</h1>
            <p className="text-sm text-gray-400 mb-6">
              One double-click to install. The SlimCast panel appears in OBS automatically.
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
            <button
              onClick={() => setStep(3)}
              className="w-full bg-blue-600 hover:bg-blue-500 py-3 rounded-xl font-semibold transition-colors mb-3"
            >
              Installed — continue
            </button>
            <button
              onClick={() => setStep(3)}
              className="w-full text-sm text-gray-500 hover:text-gray-300 py-2 transition-colors"
            >
              Skip — I&apos;ll install it later
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
              {apiKey && (
                <div className="flex items-center gap-2 text-green-400">
                  <span>✓</span><span>API key generated</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-gray-400">
                <span>→</span>
                <span>
                  Start Streaming in OBS → SlimCast auto-launches your GPU and goes live on all platforms
                </span>
              </div>
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
