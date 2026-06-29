import { ImageResponse } from 'next/og'

// Root OpenGraph image — referenced by layout.tsx metadata (openGraph + twitter
// summary_large_image) which previously declared the card without a source file.
// next/og renders with a flexbox-only subset; keep styles inline + flex.

export const runtime = 'edge'
export const alt = 'SlimCast — One stream up. Every platform live.'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
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
          backgroundColor: '#0A0A12',
          // Aurora wash, flat gradients only (next/og has no blur/filter)
          backgroundImage:
            'radial-gradient(60% 60% at 18% 12%, rgba(124,92,252,0.45), transparent 60%), radial-gradient(55% 55% at 88% 22%, rgba(255,93,162,0.32), transparent 60%), radial-gradient(60% 60% at 70% 95%, rgba(34,211,238,0.28), transparent 60%)',
        }}
      >
        {/* Brand row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div
            style={{
              display: 'flex',
              width: '52px',
              height: '52px',
              borderRadius: '14px',
              backgroundImage: 'linear-gradient(135deg, #7C5CFC 0%, #C247E6 50%, #22D3EE 100%)',
            }}
          />
          <div
            style={{
              fontSize: '34px',
              fontWeight: 700,
              color: '#F5F4FB',
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
              color: '#F5F4FB',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <span>One stream up.</span>
            <span
              style={{
                backgroundImage:
                  'linear-gradient(115deg, #7C5CFC 0%, #C247E6 46%, #FF5DA2 78%, #22D3EE 100%)',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              Four platforms live.
            </span>
          </div>
          <div style={{ marginTop: '28px', fontSize: '30px', color: '#A2A1B8', maxWidth: '900px' }}>
            One HEVC feed from OBS, transcoded on a cloud GPU, live on Twitch, YouTube, Kick, and
            TikTok at once.
          </div>
        </div>

        {/* Footer pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{ width: '14px', height: '14px', borderRadius: '9999px', backgroundColor: '#FF3B6B' }}
          />
          <div style={{ fontSize: '24px', color: '#6A6982', letterSpacing: '0.04em' }}>
            Free during early access · no second PC, no terminal
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}
