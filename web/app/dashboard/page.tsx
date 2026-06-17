'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient, type Tier } from '@/lib/supabase'

interface Profile {
  tier: Tier
  license_key: string | null
}

export default function DashboardPage() {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const supabase = createBrowserClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data } = await supabase
        .from('profiles')
        .select('tier')
        .eq('id', user.id)
        .single()

      const { data: keyRow } = await supabase
        .from('license_keys')
        .select('key')
        .eq('user_id', user.id)
        .eq('active', true)
        .single()

      setProfile({ tier: data?.tier ?? 'free', license_key: keyRow?.key ?? null })
      setLoading(false)
    }
    load()
  }, [router])

  async function handleSignOut() {
    const supabase = createBrowserClient()
    await supabase.auth.signOut()
    router.push('/')
  }

  function copyKey() {
    if (!profile?.license_key) return
    navigator.clipboard.writeText(profile.license_key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) {
    return <main className="min-h-screen bg-gray-950 text-white flex items-center justify-center">Loading...</main>
  }

  const isPro = profile?.tier === 'pro'

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-8 py-5 border-b border-gray-800">
        <span className="text-xl font-bold tracking-tight">SlimCast</span>
        <button onClick={handleSignOut} className="text-sm text-gray-400 hover:text-white transition-colors">
          Sign out
        </button>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-12 space-y-6">
        {/* Tier badge */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 flex items-center justify-between">
          <div>
            <div className="text-sm text-gray-400 mb-1">Current plan</div>
            <div className="text-2xl font-bold">{isPro ? 'Pro' : 'Free'}</div>
            {!isPro && <div className="text-sm text-gray-500 mt-1">2 platforms &middot; 720p max</div>}
            {isPro && <div className="text-sm text-gray-500 mt-1">Unlimited platforms &middot; Any quality</div>}
          </div>
          {!isPro && (
            <a
              href="/api/checkout"
              className="bg-blue-600 hover:bg-blue-500 px-5 py-2 rounded-lg text-sm font-semibold transition-colors"
            >
              Upgrade to Pro
            </a>
          )}
        </div>

        {/* License key */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="text-sm text-gray-400 mb-3">Your license key</div>
          {profile?.license_key ? (
            <div className="flex items-center gap-3">
              <code className="flex-1 bg-gray-800 rounded-lg px-4 py-2.5 text-sm font-mono tracking-wider">
                {profile.license_key}
              </code>
              <button
                onClick={copyKey}
                className="bg-gray-700 hover:bg-gray-600 px-4 py-2.5 rounded-lg text-sm transition-colors min-w-[72px]"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          ) : (
            <p className="text-gray-500 text-sm">No key found — contact support.</p>
          )}
          <p className="text-gray-600 text-xs mt-3">
            Add this to your relay&apos;s <code className="text-gray-400">run.sh</code> as <code className="text-gray-400">LICENSE_KEY=...</code>
          </p>
        </div>
      </div>
    </main>
  )
}
