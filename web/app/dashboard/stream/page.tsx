'use client'

import { DashboardNav } from '@/components/dashboard-nav'
import { StreamManager } from '@/components/stream-manager'

export default function StreamPage() {
  return (
    <div className="min-h-screen">
      <DashboardNav />
      <main className="max-w-3xl mx-auto px-6 py-10">
        <StreamManager />
      </main>
    </div>
  )
}
