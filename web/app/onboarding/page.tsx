'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Logo } from '@/components/logo'

const STEPS = ['Connect Platforms', 'Your API Key', 'Install Plugin', "You're Ready"]

const PLATFORMS = [
  { id: 'twitch',   label: 'Twitch',   note: '' },
  { id: 'kick',     label: 'Kick',     note: '' },
  { id: 'youtube',  label: 'YouTube',  note: '' },
  { id: 'tiktok',   label: 'TikTok',   note: 'Requires LIVE access (1000+ followers)' },]

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
    <main className="min-h-screen flex flex-col items-center justify-start pt-16 px-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-grid mask-fade pointer-events-none" />

      <div className="relative w-full max-w-lg">
        <div className="text-center mb-10">
          <div className="flex justify-center mb-2"><Logo href={null} /></div>
          <p className="text-ink-muted text-sm">Stream everywhere, no setup.</p>
        </div>

        {/* Progress */}
        <div className="flex gap-1 mb-10">
          {STEPS.map((label, i) => (
            <div key={label} className="flex-1 flex flex-col items-center gap-1.5">
              <div className={`h-1 w-full rounded-full transition-colors ${i <= step ? 'bg-accent' : 'bg-line'}`} />
              <span className={`text-xs ${i === step ? 'text-ink' : 'text-ink-faint'}`}>{label}</span>
            </div>
          ))}
        </div>

        {/* Step 0: Connect Platforms */}
        {step === 0 && (
          <div className="space-y-4">
            <h1 className="text-xl font-bold mb-2">Connect your platforms</h1>
            <p className="text-sm text-ink-muted mb-5">
              Paste your stream keys. SlimCast handles the rest — you never touch an RTMP URL again.
            </p>
            {PLATFORMS.map(p => (
              <div key={p.id} className="bg-surface border border-line rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">{p.label}</span>
                  {streamKeys[p.id]?.trim() && <span className="text-xs text-accent">✓ Added</span>}
                </div>
                {p.note && <p className="text-xs text-ink-faint mb-2">{p.note}</p>}
                <input
                  type="password"
                  placeholder="Stream key"
                  value={streamKeys[p.id] ?? ''}
                  onChange={e => setStreamKeys(prev => ({ ...prev, [p.id]: e.target.value }))}
                  className="w-full bg-base border border-line rounded-lg px-3 py-2 text-sm placeholder-ink-faint focus:outline-none focus:border-accent transition-colors"
                />
              </div>
            ))}
            <div className="pt-4 flex gap-3">
              <button
                onClick={savePlatforms}
                disabled={saving || connectedCount === 0}
                className="flex-1 bg-accent hover:bg-accent-strong text-base disabled:opacity-40 py-3 rounded-xl font-semibold transition-colors"
              >
                {saving ? 'Saving…' : `Continue with ${connectedCount} platform${connectedCount !== 1 ? 's' : ''}`}
              </button>
              <button onClick={() => goToApiKeyStep()} className="px-4 py-3 text-sm text-ink-faint hover:text-ink transition-colors">
                Skip
              </button>
            </div>
          </div>
        )}

        {/* Step 1: API Key */}
        {step === 1 && (
          <div>
            <h1 className="text-xl font-bold mb-2">Your API key</h1>
            <p className="text-sm text-ink-muted mb-6">
              This key links your OBS plugin to your SlimCast account. Enter it once in the SlimCast panel inside OBS — you&apos;re never asked again.
            </p>

            {apiKeyLoading && (
              <div className="bg-surface border border-line rounded-xl p-6 text-center text-ink-faint text-sm mb-4">
                Generating your key…
              </div>
            )}

            {apiKey && (
              <div className="space-y-3 mb-6">
                <div className="bg-amber-950/30 border border-amber-800/60 rounded-xl px-4 py-3 text-sm text-amber-400">
                  Copy this key now — it won&apos;t be shown again.
                </div>
                <div className="flex items-center gap-3">
                  <code className="flex-1 bg-base border border-line rounded-xl px-4 py-3 text-sm font-mono text-ink break-all">
                    {apiKey}
                  </code>
                  <button
                    onClick={copyKey}
                    className={`px-4 py-3 rounded-xl text-sm font-semibold transition-colors min-w-[80px] ${apiKeyCopied ? 'bg-accent-strong text-base' : 'bg-accent hover:bg-accent-strong text-base'}`}
                  >
                    {apiKeyCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            <div className="bg-surface border border-line rounded-xl p-4 text-sm text-ink-muted space-y-2 mb-6">
              <p className="font-medium text-ink text-xs uppercase tracking-wider mb-3">Where to paste it</p>
              {[
                <>Open OBS → look for the <strong className="text-ink">SlimCast</strong> panel in your docks</>,
                <>Click the <strong className="text-ink">Account</strong> tab</>,
                <>Paste your API key and click <strong className="text-ink">Save</strong></>,
              ].map((line, i) => (
                <div key={i} className="flex gap-3">
                  <span className="text-accent font-bold shrink-0">{i + 1}.</span>
                  <span>{line}</span>
                </div>
              ))}
            </div>

            <p className="text-xs text-ink-faint mb-6">
              Lost your key? Generate a new one anytime from the dashboard. This invalidates the old key.
            </p>

            <button
              onClick={() => setStep(2)}
              className="w-full bg-accent hover:bg-accent-strong text-base py-3 rounded-xl font-semibold transition-colors"
            >
              I&apos;ve copied it — continue
            </button>
          </div>
        )}

        {/* Step 2: Install Plugin */}
        {step === 2 && (
          <div>
            <h1 className="text-xl font-bold mb-2">Install the OBS plugin</h1>
            <p className="text-sm text-ink-muted mb-6">
              One double-click to install. The SlimCast panel appears in OBS automatically.
            </p>
            <div className="flex gap-3 mb-6">
              <a href="/downloads/slimcast-obs-plugin.pkg" className="flex-1 bg-surface hover:bg-elevated border border-line py-4 rounded-xl text-center transition-colors">
                <div className="font-semibold mb-1">Mac</div>
                <div className="text-xs text-ink-faint">.pkg installer</div>
              </a>
              <a href="/downloads/slimcast-obs-plugin.exe" className="flex-1 bg-surface hover:bg-elevated border border-line py-4 rounded-xl text-center transition-colors">
                <div className="font-semibold mb-1">Windows</div>
                <div className="text-xs text-ink-faint">.exe installer</div>
              </a>
            </div>
            <button onClick={() => setStep(3)} className="w-full bg-accent hover:bg-accent-strong text-base py-3 rounded-xl font-semibold transition-colors mb-3">
              Installed — continue
            </button>
            <button onClick={() => setStep(3)} className="w-full text-sm text-ink-faint hover:text-ink py-2 transition-colors">
              Skip — I&apos;ll install it later
            </button>
          </div>
        )}

        {/* Step 3: Done */}
        {step === 3 && (
          <div className="text-center">
            <div className="text-5xl mb-4">🎉</div>
            <h1 className="text-2xl font-bold mb-2">You&apos;re ready to stream.</h1>
            <p className="text-ink-muted text-sm mb-2">2 free hours in your account. No credit card required to start.</p>
            <p className="text-ink-faint text-sm mb-8">Open OBS and click Start Streaming. That&apos;s it.</p>

            <div className="bg-surface border border-line rounded-xl p-4 text-left text-sm space-y-2 mb-8">
              {connectedCount > 0 && (
                <div className="flex items-center gap-2 text-accent">
                  <span>✓</span><span>{connectedCount} platform{connectedCount !== 1 ? 's' : ''} connected</span>
                </div>
              )}
              {apiKey && (
                <div className="flex items-center gap-2 text-accent">
                  <span>✓</span><span>API key generated</span>
                </div>
              )}
              <div className="flex items-center gap-2 text-ink-muted">
                <span>→</span>
                <span>Start Streaming in OBS → SlimCast auto-launches your GPU and goes live on all platforms</span>
              </div>
            </div>

            <button onClick={() => router.push('/dashboard')} className="w-full bg-accent hover:bg-accent-strong text-base py-3 rounded-xl font-semibold transition-colors">
              Open Dashboard
            </button>
          </div>
        )}
      </div>
    </main>
  )
}
