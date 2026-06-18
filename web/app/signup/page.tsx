'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { Logo } from '@/components/logo'

const PERKS = [
  '2 free hours — no credit card',
  'All five platforms, full 1080p60',
  'Pay-per-second after that, $2/hr',
]

export default function SignupPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const supabase = createBrowserClient()
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) {
      setError(error.message || JSON.stringify(error))
      setLoading(false)
      return
    }

    if (!data.session) {
      setError('Check your email to confirm your account before logging in.')
      setLoading(false)
      return
    }

    router.push('/onboarding')
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-grid mask-fade pointer-events-none" />
      <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-accent/10 rounded-full blur-[120px] pointer-events-none" />

      <div className="relative w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Logo />
        </div>

        <div className="bg-surface border border-line rounded-2xl p-8">
          <h1 className="text-xl font-semibold mb-1">Create your account</h1>
          <p className="text-sm text-ink-muted mb-5">Start streaming everywhere in minutes.</p>

          <ul className="space-y-2 mb-6">
            {PERKS.map(p => (
              <li key={p} className="flex items-center gap-2 text-xs text-ink-muted">
                <svg viewBox="0 0 20 20" className="w-3.5 h-3.5 text-accent shrink-0" fill="currentColor">
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 10a1 1 0 1 1 1.4-1.4l3.3 3.3 6.8-6.8a1 1 0 0 1 1.4 0z" clipRule="evenodd" />
                </svg>
                {p}
              </li>
            ))}
          </ul>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full bg-base border border-line rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-accent transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-muted mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full bg-base border border-line rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-accent transition-colors"
              />
              <p className="text-xs text-ink-faint mt-1.5">At least 8 characters.</p>
            </div>
            {error && (
              <p className="text-red-400 text-sm bg-red-950/30 border border-red-900/50 rounded-lg px-3 py-2">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-accent hover:bg-accent-strong text-base disabled:opacity-50 py-2.5 rounded-lg font-semibold text-sm transition-colors"
            >
              {loading ? 'Creating account…' : 'Create account'}
            </button>
          </form>
        </div>

        <p className="text-ink-muted text-sm text-center mt-6">
          Already have an account?{' '}
          <Link href="/login" className="text-accent hover:text-accent-strong font-medium">Log in</Link>
        </p>
      </div>
    </main>
  )
}
