'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { CheckCircle2, Loader2 } from 'lucide-react'

import { createBrowserClient } from '@/lib/supabase'
import { Logo } from '@/components/logo'
import { AuthPanel } from '@/components/auth/auth-panel'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'

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
    <main className="grid min-h-screen lg:grid-cols-2">
      <AuthPanel />

      <div className="flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex justify-center lg:hidden">
            <Logo />
          </div>

          <Card className="shadow-lg">
            <CardHeader>
              <CardTitle className="font-display text-xl">Connect OBS</CardTitle>
              <CardDescription>
                Authorize the SlimCast OBS plugin on this computer to control your account.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {status === 'checking' && (
                <div className="flex items-center justify-center gap-2 py-4 text-sm text-ink-muted">
                  <Loader2 className="size-4 animate-spin" />
                  Checking…
                </div>
              )}

              {status === 'ready' && (
                <Button
                  onClick={authorize}
                  className="h-11 w-full rounded-xl text-sm font-semibold shadow-glow"
                >
                  Authorize OBS
                </Button>
              )}

              {status === 'working' && (
                <div className="flex items-center justify-center gap-2 py-4 text-sm text-ink-muted">
                  <Loader2 className="size-4 animate-spin" />
                  Authorizing…
                </div>
              )}

              {status === 'done' && (
                <Alert className="border-success/40 text-success">
                  <CheckCircle2 className="size-4" />
                  <AlertDescription className="text-success/90">
                    Authorized — return to OBS. You can close this tab.
                  </AlertDescription>
                </Alert>
              )}

              {status === 'error' && (
                <Alert variant="destructive">
                  <AlertDescription>{message}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          <p className="mt-6 text-center text-xs text-ink-faint">
            Only authorize if you just clicked “Connect” in your own OBS.
          </p>
        </div>
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
