import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950 text-white">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-gray-800">
        <span className="text-xl font-bold tracking-tight">SlimCast</span>
        <div className="flex gap-4 text-sm">
          <Link href="/login" className="text-gray-400 hover:text-white transition-colors">Log in</Link>
          <Link href="/signup" className="bg-blue-600 hover:bg-blue-500 px-4 py-1.5 rounded-md transition-colors">Get started</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex flex-col items-center text-center px-6 pt-28 pb-20">
        <div className="text-xs font-semibold tracking-widest text-blue-400 uppercase mb-4">Multistreaming made simple</div>
        <h1 className="text-5xl md:text-6xl font-extrabold leading-tight max-w-3xl mb-6">
          Stream everywhere.<br />No setup required.
        </h1>
        <p className="text-gray-400 text-lg max-w-xl mb-10">
          Push one stream from OBS and go live on Twitch, Kick, YouTube, TikTok, and Facebook simultaneously.
          SlimCast handles the encoding and fan-out — you just click Start Streaming.
        </p>
        <div className="flex gap-4 flex-wrap justify-center">
          <Link href="/signup" className="bg-blue-600 hover:bg-blue-500 px-8 py-3 rounded-lg font-semibold text-lg transition-colors">
            Start free — 2 hours included
          </Link>
          <a href="#pricing" className="border border-gray-700 hover:border-gray-500 px-8 py-3 rounded-lg font-semibold text-lg transition-colors">
            See pricing
          </a>
        </div>
      </section>

      {/* Features */}
      <section className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto px-6 pb-24">
        {[
          { title: 'One click to go live', body: 'Click Start Streaming in OBS. Your streaming server starts automatically and all platforms go live.' },
          { title: 'HEVC uplink', body: 'Push ~40% less data upstream than H.264. SlimCast transcodes to H.264 on the GPU for each platform.' },
          { title: 'All 5 platforms', body: 'Twitch, Kick, YouTube, TikTok (portrait), and Facebook — simultaneously, from a single OBS stream.' },
        ].map(f => (
          <div key={f.title} className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h3 className="font-semibold text-lg mb-2">{f.title}</h3>
            <p className="text-gray-400 text-sm">{f.body}</p>
          </div>
        ))}
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-2xl mx-auto px-6 pb-32">
        <h2 className="text-3xl font-bold text-center mb-4">Simple pricing</h2>
        <p className="text-gray-400 text-center mb-12">Pay only for what you stream. No subscription, no commitment.</p>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8">
          <div className="flex items-end gap-2 mb-2">
            <div className="text-5xl font-extrabold">$2</div>
            <div className="text-gray-400 text-lg mb-1.5">/ hour</div>
          </div>
          <div className="text-gray-500 text-sm mb-8">Billed in seconds. Credits never expire.</div>

          <ul className="space-y-3 text-sm text-gray-300 mb-8">
            <li className="flex items-center gap-2"><span className="text-blue-400">✓</span> All 5 platforms simultaneously</li>
            <li className="flex items-center gap-2"><span className="text-blue-400">✓</span> 1080p60 max quality</li>
            <li className="flex items-center gap-2"><span className="text-blue-400">✓</span> Auto-starts when you hit Start Streaming in OBS</li>
            <li className="flex items-center gap-2"><span className="text-blue-400">✓</span> Auto-refill when balance gets low</li>
            <li className="flex items-center gap-2"><span className="text-green-400">✓</span> <strong>2 free hours on signup</strong></li>
          </ul>

          <Link href="/signup" className="block text-center bg-blue-600 hover:bg-blue-500 font-semibold py-3 rounded-lg transition-colors">
            Get started — free
          </Link>
        </div>
      </section>
    </main>
  )
}
