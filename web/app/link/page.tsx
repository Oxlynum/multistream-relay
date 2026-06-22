'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Logo } from '@/components/logo'

// Device-link consent page. The OBS plugin opens this in the browser with its
// PKCE challenge + loopback port. The user (logged in) clicks Authorize; we mint
// a one-time code and redirect back to the plugin's 127.0.0.1 listener.

function LinkInner() {
  const params = useSearchParams()
  const challenge = params.get('challenge') ?? ''
  const state = params.get('state') ?? ''
  const portRaw = params.get('port') ?? ''
  const port = /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : 0

  const [status, setStatus] = useState<'checking' | 'ready' | 'working' | 'done' | 'error'>('checking')
  const [message, setMessage] = useState('')

  const validParams = /^[A-Za-z0-9_-]{43}$/.test(challenge) && port > 0 && port <= 65535

  useEffect(() => {
    async function check() {
      if (!validParams) {
        setStatus('error')
        setMessage('This link is invalid or expired. Click "Connect" again in OBS.')
        return
      }
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        const here = `/link?challenge=${encodeURIComponent(challenge)}&state=${encodeURIComponent(state)}&port=${port}`
        window.location.href = `/login?next=${encodeURIComponent(here)}`
        return
      }
      setStatus('ready')
    }
    check()
  }, [validParams, challenge, state, port])

  async function authorize() {
    setStatus('working')
    setMessage('')
    try {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Your session expired — please sign in again.')

      const res = await fetch('/api/link/authorize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ challenge }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Could not authorize.')

      // Hand the one-time code back to the plugin's loopback listener.
      const redirect = `http://127.0.0.1:${port}/callback?code=${encodeURIComponent(body.code)}&state=${encodeURIComponent(state)}`
      setStatus('done')
      window.location.href = redirect
    } catch (e) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : 'Something went wrong.')
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-grid mask-fade pointer-events-none" />
      <div className="relative w-full max-w-sm">
        <div className="flex justify-center mb-8"><Logo /></div>
        <div className="bg-surface border border-line rounded-2xl p-8 text-center">
          <h1 className="text-xl font-semibold mb-1">Connect OBS</h1>
          <p className="text-sm text-ink-muted mb-6">
            Authorize the SlimCast OBS plugin on this computer to control your account.
          </p>

          {status === 'checking' && <p className="text-sm text-ink-muted">Checking…</p>}

          {status === 'ready' && (
            <button
              onClick={authorize}
              className="w-full bg-accent hover:bg-accent-strong text-base py-2.5 rounded-lg font-semibold text-sm transition-colors"
            >
              Authorize OBS
            </button>
          )}

          {status === 'working' && <p className="text-sm text-ink-muted">Authorizing…</p>}

          {status === 'done' && (
            <p className="text-sm text-accent">
              Authorized — return to OBS. You can close this tab.
            </p>
          )}

          {status === 'error' && (
            <p className="text-red-400 text-sm bg-red-950/30 border border-red-900/50 rounded-lg px-3 py-2">
              {message}
            </p>
          )}
        </div>
        <p className="text-ink-faint text-xs text-center mt-6">
          Only authorize if you just clicked “Connect” in your own OBS.
        </p>
      </div>
    </main>
  )
}

export default function LinkPage() {
  return (
    <Suspense>
      <LinkInner />
    </Suspense>
  )
}
