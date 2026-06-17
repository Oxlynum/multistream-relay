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
        <div className="text-xs font-semibold tracking-widest text-blue-400 uppercase mb-4">Self-hosted multistreaming</div>
        <h1 className="text-5xl md:text-6xl font-extrabold leading-tight max-w-3xl mb-6">
          Stream everywhere.<br />Use less bandwidth.
        </h1>
        <p className="text-gray-400 text-lg max-w-xl mb-10">
          SlimCast encodes once on a cloud GPU and fans out to Twitch, Kick, YouTube — and more.
          One lightweight HEVC upload from your PC, crisp 1080p60 to every platform.
        </p>
        <div className="flex gap-4 flex-wrap justify-center">
          <Link href="/signup" className="bg-blue-600 hover:bg-blue-500 px-8 py-3 rounded-lg font-semibold text-lg transition-colors">
            Start for free
          </Link>
          <a href="#pricing" className="border border-gray-700 hover:border-gray-500 px-8 py-3 rounded-lg font-semibold text-lg transition-colors">
            See pricing
          </a>
        </div>
      </section>

      {/* Features */}
      <section className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto px-6 pb-24">
        {[
          { title: 'Hardware encoded', body: 'Apple VT on your Mac, NVENC on the GPU. No software encoding bottlenecks.' },
          { title: 'HEVC uplink', body: 'Push ~40% less data upstream than H.264 at the same quality.' },
          { title: 'Self-hosted', body: 'Runs on your own GPU rental. You control your keys and your stream.' },
        ].map(f => (
          <div key={f.title} className="bg-gray-900 rounded-xl p-6 border border-gray-800">
            <h3 className="font-semibold text-lg mb-2">{f.title}</h3>
            <p className="text-gray-400 text-sm">{f.body}</p>
          </div>
        ))}
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-4xl mx-auto px-6 pb-32">
        <h2 className="text-3xl font-bold text-center mb-12">Simple pricing</h2>
        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8">
            <div className="text-gray-400 text-sm font-semibold uppercase tracking-widest mb-2">Free</div>
            <div className="text-4xl font-extrabold mb-1">$0</div>
            <div className="text-gray-500 text-sm mb-8">Forever</div>
            <ul className="space-y-3 text-sm text-gray-300 mb-8">
              <li>Up to 2 platforms</li>
              <li>720p max resolution</li>
              <li>HEVC uplink</li>
            </ul>
            <Link href="/signup" className="block text-center border border-gray-700 hover:border-gray-500 py-2.5 rounded-lg transition-colors">
              Get started
            </Link>
          </div>

          <div className="bg-blue-600 rounded-2xl p-8">
            <div className="text-blue-200 text-sm font-semibold uppercase tracking-widest mb-2">Pro</div>
            <div className="text-4xl font-extrabold mb-1">$9<span className="text-xl font-normal text-blue-200">/mo</span></div>
            <div className="text-blue-200 text-sm mb-8">or $59/yr &middot; $99 lifetime</div>
            <ul className="space-y-3 text-sm mb-8">
              <li>Unlimited platforms</li>
              <li>Any resolution &amp; quality</li>
              <li>HEVC uplink</li>
              <li>Priority support</li>
            </ul>
            <Link href="/signup" className="block text-center bg-white text-blue-700 font-semibold py-2.5 rounded-lg hover:bg-blue-50 transition-colors">
              Upgrade to Pro
            </Link>
          </div>
        </div>
      </section>
    </main>
  )
}
