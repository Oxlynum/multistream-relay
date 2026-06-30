'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Check, CreditCard, Loader2 } from 'lucide-react'

import { createBrowserClient } from '@/lib/supabase'
import { Logo } from '@/components/logo'
import { Stepper } from '@/components/onboarding/stepper'
import { GradientText } from '@/components/ui/gradient-text'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'

const STEPS = ['Connect Platforms', 'Secure Account', 'Your API Key', 'Install Plugin', 'Done']

const PLATFORMS = [
  { id: 'twitch', label: 'Twitch', note: '' },
  { id: 'kick', label: 'Kick', note: '' },
  { id: 'youtube', label: 'YouTube', note: '' },
  { id: 'tiktok', label: 'TikTok', note: 'Requires LIVE access (1000+ followers)' },
]

export default function OnboardingPage() {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [streamKeys, setStreamKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [apiKeyCopied, setApiKeyCopied] = useState(false)
  const [apiKeyLoading, setApiKeyLoading] = useState(false)
  const [apiKeyError, setApiKeyError] = useState('')
  const [stripeLoading, setStripeLoading] = useState(false)

  const generateKey = useCallback(async (tok: string) => {
    setApiKeyLoading(true)
    setApiKeyError('')
    try {
      const res = await fetch('/api/apikey', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}` },
      })
      const body = await res.json()
      if (!res.ok || !body.api_key) {
        // 403 = no payment method on file · 429 = rate-limited
        setApiKeyError(
          res.status === 403
            ? 'Add a payment method first, then generate your API key.'
            : res.status === 429
              ? 'Too many attempts — wait a moment, then try again.'
              : (body.error ?? 'Could not generate your API key. Please try again.'),
        )
        return
      }
      setApiKey(body.api_key)
    } finally {
      setApiKeyLoading(false)
    }
  }, [])

  useEffect(() => {
    async function init() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      setToken(session.access_token)

      const urlParams = new URLSearchParams(window.location.search)
      if (urlParams.get('setup_success') === '1') {
        const step = parseInt(urlParams.get('step') ?? '2', 10)
        setStep(step)
        // Returning from Stripe lands on the API-key step — mint it now (shown once).
        if (step === 2) generateKey(session.access_token)
      }
    }
    init()
  }, [router, generateKey])

  const connectedCount = Object.values(streamKeys).filter(v => v.trim()).length

  async function savePlatforms() {
    if (!token || connectedCount === 0) return
    setSaving(true)
    setSaveError('')
    const entries = Object.entries(streamKeys).filter(([, key]) => key.trim())
    // allSettled + per-key res.ok: a plain Promise.all treated any non-2xx as success
    // (fetch only rejects on a network error, not an HTTP error) and advanced the wizard,
    // SILENTLY LOSING the stream key at the highest-stakes funnel step (enterprise-audit UX-02).
    const results = await Promise.allSettled(
      entries.map(([platform, key]) =>
        fetch('/api/platforms', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform, stream_key: key.trim() }),
        }).then(async res => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error(body.error ?? `HTTP ${res.status}`)
          }
        }),
      ),
    )
    setSaving(false)
    const failed = entries
      .map(([platform], i) => ({ platform, result: results[i] }))
      .filter(x => x.result.status === 'rejected')
    if (failed.length) {
      const labelOf = (id: string) => PLATFORMS.find(p => p.id === id)?.label ?? id
      // Stay on this step with actionable messaging — do NOT advance and drop the keys.
      setSaveError(
        `Couldn't save ${failed.map(f => labelOf(f.platform)).join(', ')}. ` +
        `Your keys weren't lost — check them and try again.`,
      )
      return
    }
    setStep(1) // all keys persisted → Move to Secure Account
  }

  async function handleSetupPayment() {
    if (!token) return
    setStripeLoading(true)
    const res = await fetch('/api/stripe/setup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    })
    const { url } = await res.json()
    if (url) window.location.href = url
    setStripeLoading(false)
  }

  function copyKey() {
    if (!apiKey) return
    navigator.clipboard.writeText(apiKey)
    setApiKeyCopied(true)
    setTimeout(() => setApiKeyCopied(false), 2000)
  }

  return (
    <main className="relative min-h-screen overflow-hidden px-6 pt-14 pb-20">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-dotgrid opacity-50" />

      <div className="relative mx-auto w-full max-w-lg">
        {/* Header */}
        <div className="mb-9 text-center">
          <div className="mb-2 flex justify-center"><Logo href={null} /></div>
          <p className="text-sm text-ink-muted">Stream everywhere, no setup.</p>
        </div>

        {/* Progress */}
        <div className="mb-10">
          <Stepper steps={STEPS} step={step} />
        </div>

        {/* Step 0: Connect Platforms */}
        {step === 0 && (
          <div className="space-y-4">
            <div>
              <h1 className="font-display text-xl font-bold text-ink">Connect your platforms</h1>
              <p className="mt-1.5 text-sm text-ink-muted">
                Paste your stream keys. SlimCast handles the rest — you never touch an RTMP URL again.
              </p>
            </div>

            {PLATFORMS.map(p => (
              <Card key={p.id}>
                <CardContent className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-ink">{p.label}</span>
                    {streamKeys[p.id]?.trim() && (
                      <Badge variant="outline" className="border-success/40 bg-success/10 text-success">
                        <Check className="size-3" /> Added
                      </Badge>
                    )}
                  </div>
                  {p.note && <p className="text-xs text-ink-faint">{p.note}</p>}
                  <Input
                    type="password"
                    placeholder="Stream key"
                    value={streamKeys[p.id] ?? ''}
                    onChange={e => setStreamKeys(prev => ({ ...prev, [p.id]: e.target.value }))}
                    className="h-10"
                  />
                </CardContent>
              </Card>
            ))}

            {saveError && (
              <Alert variant="destructive">
                <AlertDescription>{saveError}</AlertDescription>
              </Alert>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                onClick={savePlatforms}
                disabled={saving || connectedCount === 0}
                className="h-11 flex-1 rounded-xl text-sm font-semibold shadow-glow"
              >
                {saving ? (
                  <><Loader2 className="size-4 animate-spin" /> Saving…</>
                ) : (
                  `Continue with ${connectedCount} platform${connectedCount !== 1 ? 's' : ''}`
                )}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setStep(1)}
                className="h-11 rounded-xl px-4 text-sm text-ink-faint hover:text-ink"
              >
                Skip
              </Button>
            </div>
          </div>
        )}

        {/* Step 1: Secure Account */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <h1 className="font-display text-xl font-bold text-ink">Secure your account</h1>
              <p className="mt-1.5 text-sm text-ink-muted">
                To prevent abuse of our free trial, we require a valid card. You will not be charged —
                your 2 free tokens land immediately.
              </p>
            </div>

            <Card className="shadow-lg">
              <CardContent className="space-y-5 py-6 text-center">
                <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-brand/15 text-brand">
                  <CreditCard className="size-6" />
                </span>
                <div>
                  <h3 className="font-display font-semibold text-ink">Verify payment method</h3>
                  <p className="mt-1.5 text-sm text-ink-faint">
                    Redirecting to Stripe to securely save your card. We never store your card details.
                  </p>
                </div>
                <Button
                  onClick={handleSetupPayment}
                  disabled={stripeLoading}
                  className="h-11 w-full rounded-xl text-sm font-semibold shadow-glow"
                >
                  {stripeLoading ? (
                    <><Loader2 className="size-4 animate-spin" /> Connecting to Stripe…</>
                  ) : (
                    'Add payment method'
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Step 2: API Key */}
        {step === 2 && (
          <div className="space-y-5">
            <div>
              <h1 className="font-display text-xl font-bold text-ink">Your API key</h1>
              <p className="mt-1.5 text-sm text-ink-muted">
                This key links your OBS plugin to your SlimCast account. Enter it once in the SlimCast
                panel inside OBS — you&apos;re never asked again.
              </p>
            </div>

            {apiKeyLoading && (
              <Card>
                <CardContent className="flex items-center justify-center gap-2 py-6 text-sm text-ink-faint">
                  <Loader2 className="size-4 animate-spin" />
                  Generating your key…
                </CardContent>
              </Card>
            )}

            {apiKeyError && (
              <Alert variant="destructive">
                <AlertDescription className="flex items-center justify-between gap-3">
                  <span>{apiKeyError}</span>
                  {token && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => generateKey(token)}
                      className="shrink-0"
                    >
                      Try again
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {apiKey && (
              <div className="space-y-3">
                <Alert className="border-warning/40 text-warning">
                  <AlertDescription className="text-warning/90">
                    Copy this key now — it won&apos;t be shown again.
                  </AlertDescription>
                </Alert>
                <div className="flex items-center gap-3">
                  <code className="flex-1 rounded-xl border border-line bg-surface-2 px-4 py-3 font-mono text-sm break-all text-ink">
                    {apiKey}
                  </code>
                  <Button
                    onClick={copyKey}
                    className="h-12 min-w-[80px] rounded-xl text-sm font-semibold"
                  >
                    {apiKeyCopied ? 'Copied!' : 'Copy'}
                  </Button>
                </div>
              </div>
            )}

            <Card>
              <CardContent className="space-y-3">
                <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-ink-faint">
                  Where to paste it
                </p>
                {[
                  <>Open OBS → look for the <strong className="text-ink">SlimCast</strong> panel in your docks</>,
                  <>Click the <strong className="text-ink">Account</strong> tab</>,
                  <>Paste your API key and click <strong className="text-ink">Save</strong></>,
                ].map((line, i) => (
                  <div key={i} className="flex gap-3 text-sm text-ink-muted">
                    <span className="shrink-0 font-mono font-bold text-brand">{i + 1}.</span>
                    <span>{line}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <p className="text-xs text-ink-faint">
              Lost your key? Generate a new one anytime from the dashboard. This invalidates the old key.
            </p>

            <Button
              onClick={() => setStep(3)}
              className="h-11 w-full rounded-xl text-sm font-semibold shadow-glow"
            >
              I&apos;ve copied it — continue
            </Button>
          </div>
        )}

        {/* Step 3: Install Plugin */}
        {step === 3 && (
          <div className="space-y-5">
            <div>
              <h1 className="font-display text-xl font-bold text-ink">Install the OBS plugin</h1>
              <p className="mt-1.5 text-sm text-ink-muted">
                One double-click to install. The SlimCast panel appears in OBS automatically.
              </p>
            </div>

            <div className="flex gap-3">
              <a
                href="/downloads/slimcast-obs-plugin.pkg"
                className="flex-1 rounded-xl border border-line bg-surface py-4 text-center transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md"
              >
                <div className="font-display font-semibold text-ink">Mac</div>
                <div className="mt-0.5 text-xs text-ink-faint">.pkg installer</div>
              </a>
              <a
                href="/downloads/slimcast-obs-plugin.exe"
                className="flex-1 rounded-xl border border-line bg-surface py-4 text-center transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md"
              >
                <div className="font-display font-semibold text-ink">Windows</div>
                <div className="mt-0.5 text-xs text-ink-faint">.exe installer</div>
              </a>
            </div>

            <div className="space-y-2">
              <Button
                onClick={() => setStep(4)}
                className="h-11 w-full rounded-xl text-sm font-semibold shadow-glow"
              >
                Installed — continue
              </Button>
              <Button
                variant="ghost"
                onClick={() => setStep(4)}
                className="h-9 w-full text-sm text-ink-faint hover:text-ink"
              >
                Skip — I&apos;ll install it later
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Done */}
        {step === 4 && (
          <Card className="relative overflow-hidden text-center shadow-glow">
            <div aria-hidden className="aurora-bg pointer-events-none absolute inset-0 opacity-70" />
            <CardContent className="relative space-y-4 py-8">
              <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-gradient-brand text-[#0A0A12] shadow-glow">
                <Check className="size-7" strokeWidth={3} />
              </span>
              <div>
                <h1 className="font-display text-2xl font-bold">
                  <GradientText>You&apos;re ready to stream.</GradientText>
                </h1>
                <p className="mt-2 text-sm text-ink-muted">
                  2 free tokens are in your account. Free during early access.
                </p>
                <p className="mt-1 text-sm text-ink-faint">
                  Open OBS and click Start Streaming. That&apos;s it.
                </p>
              </div>

              <div className="space-y-2 rounded-xl border border-line bg-surface/80 p-4 text-left text-sm">
                {connectedCount > 0 && (
                  <div className="flex items-center gap-2 text-success">
                    <Check className="size-4 shrink-0" />
                    <span>{connectedCount} platform{connectedCount !== 1 ? 's' : ''} connected</span>
                  </div>
                )}
                {apiKey && (
                  <div className="flex items-center gap-2 text-success">
                    <Check className="size-4 shrink-0" />
                    <span>API key generated</span>
                  </div>
                )}
                <div className="flex items-start gap-2 text-ink-muted">
                  <span aria-hidden className="shrink-0 text-brand">→</span>
                  <span>Start Streaming in OBS → SlimCast auto-launches your GPU and goes live on all platforms</span>
                </div>
              </div>

              <Button
                onClick={() => router.push('/dashboard')}
                className="h-11 w-full rounded-xl text-sm font-semibold shadow-glow"
              >
                Open dashboard
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  )
}
