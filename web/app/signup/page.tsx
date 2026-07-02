'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, Loader2 } from 'lucide-react'

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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

const PERKS = [
  '2 free tokens on signup',
  'All four platforms, full 1080p60',
  'Free during early access — token pricing later, $2/token or $20/mo',
]

export default function SignupPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    setNotice('')

    const supabase = createBrowserClient()
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) {
      setError(error.message || JSON.stringify(error))
      setLoading(false)
      return
    }

    if (!data.session) {
      // Email-confirmation required — informational, not an error.
      setNotice('Check your email to confirm your account before logging in.')
      setLoading(false)
      return
    }

    // Keep the spinner through navigation — do NOT reset `loading` on success.
    router.push('/onboarding')
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
              <CardTitle className="font-display text-xl">Create your account</CardTitle>
              <CardDescription>Start streaming everywhere in minutes.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <ul className="space-y-2.5">
                {PERKS.map((p) => (
                  <li key={p} className="flex items-start gap-2.5 text-xs text-ink-muted">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="h-10"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    className="h-10"
                  />
                  <p className="text-xs text-ink-faint">At least 8 characters.</p>
                </div>

                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {notice && (
                  <Alert className="border-cyan/40 text-cyan">
                    <AlertDescription className="text-cyan/90">{notice}</AlertDescription>
                  </Alert>
                )}

                <Button
                  type="submit"
                  disabled={loading}
                  className="h-11 w-full text-sm shadow-glow"
                >
                  {loading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Creating account…
                    </>
                  ) : (
                    'Sign up'
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          <p className="mt-6 text-center text-sm text-ink-muted">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-brand hover:text-brand-strong">
              Log in
            </Link>
          </p>
        </div>
      </div>
    </main>
  )
}
