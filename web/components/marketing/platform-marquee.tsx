import { PlatformIcon, PLATFORM_META, type PlatformKey } from '@/components/platform-icon'

const PLATFORMS: PlatformKey[] = ['twitch', 'youtube', 'kick', 'tiktok']

/**
 * One scrolling copy of the platform lockups. Rendered twice inside a single
 * `.animate-marquee` track (which travels translateX 0 → -50%) for a seamless
 * loop. The first copy stays in the accessibility tree (exposes the supported
 * platforms); the duplicate is `aria-hidden` so names aren't read twice.
 */
function MarqueeRow({ decorative = false }: { decorative?: boolean }) {
  return (
    <div aria-hidden={decorative || undefined} className="flex shrink-0 items-center">
      {PLATFORMS.map((p) => (
        <span key={p} className="flex items-center gap-3 pr-12 md:pr-20">
          <span style={{ color: PLATFORM_META[p].tint }}>
            <PlatformIcon platform={p} className="h-6 w-6 md:h-7 md:w-7" />
          </span>
          <span className="font-display text-lg font-semibold tracking-tight text-ink-muted md:text-xl">
            {PLATFORM_META[p].label}
          </span>
        </span>
      ))}
    </div>
  )
}

/** Supported-platform marquee band (server component). */
export function PlatformMarquee() {
  return (
    <section aria-label="Supported platforms" className="border-b border-line bg-bg-subtle">
      <h2 className="sr-only">Stream to Twitch, YouTube, Kick, and TikTok</h2>
      <div className="relative flex overflow-hidden py-8">
        <div className="flex w-max animate-marquee">
          <MarqueeRow />
          <MarqueeRow decorative />
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-24 bg-gradient-to-r from-bg-subtle to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-24 bg-gradient-to-l from-bg-subtle to-transparent"
        />
      </div>
    </section>
  )
}
