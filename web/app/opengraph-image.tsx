import { ImageResponse } from 'next/og'

// Root OpenGraph image — referenced by layout.tsx metadata (openGraph + twitter
// summary_large_image) which previously declared the card without a source file.
// next/og renders with a flexbox-only subset; keep styles inline + flex.

export const runtime = 'edge'
export const alt = 'SlimCast — One stream up. Every platform live.'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function OpengraphImage() {
  // Use the small quantized logo (not the full 448KB mark) — bundling the big one
  // pushed this edge function over Vercel's 1 MB size limit and failed the deploy.
  const logo = await fetch(new URL('../public/logo-og.png', import.meta.url)).then(res =>
    res.arrayBuffer(),
  )

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '80px',
          backgroundColor: '#050505',
          // Arcade neon wash, flat gradients only (next/og has no blur/filter)
          backgroundImage:
            'radial-gradient(60% 60% at 18% 12%, rgba(163,240,0,0.40), transparent 60%), radial-gradient(55% 55% at 88% 22%, rgba(255,77,242,0.26), transparent 60%), radial-gradient(60% 60% at 70% 95%, rgba(34,232,255,0.26), transparent 60%)',
        }}
      >
        {/* Brand row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          {/* @ts-expect-error next/og img accepts an ArrayBuffer-backed src */}
          <img src={logo} alt="" width={62} height={52} style={{ objectFit: 'contain' }} />
          <div
            style={{
              fontSize: '34px',
              fontWeight: 700,
              color: '#eaffd6',
              letterSpacing: '-0.02em',
            }}
          >
            SlimCast
          </div>
        </div>

        {/* Headline */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontSize: '88px',
              fontWeight: 700,
              lineHeight: 1.0,
              letterSpacing: '-0.03em',
              color: '#eaffd6',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <span>Stream anywhere.</span>
            <span
              style={{
                backgroundImage:
                  'linear-gradient(115deg, #a3f000 0%, #22e8ff 52%, #ff4df2 100%)',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              Go live everywhere.
            </span>
          </div>
          <div style={{ marginTop: '28px', fontSize: '30px', color: '#8fae6e', maxWidth: '900px' }}>
            Smooth streams even on bad WiFi — up to 8% packet loss, no drops — live on Twitch,
            YouTube, Kick, and TikTok at once.
          </div>
        </div>

        {/* Footer pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{ width: '14px', height: '14px', borderRadius: '0', backgroundColor: '#ff414d' }}
          />
          <div style={{ fontSize: '24px', color: '#5f7444', letterSpacing: '0.04em' }}>
            Free during early access · no second PC, no terminal
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}
