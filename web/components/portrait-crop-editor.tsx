'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createBrowserClient } from '@/lib/supabase'

// 9:16 crop window over a 16:9 source. Mirrors relay/supervisor.py:portrait_crop_rect.
// At zoom=1 the window is the full source height; width = height * 9/16.
const CROP_W_AT_ZOOM_1 = (9 / 16) * (9 / 16) // (1080/1 * 9/16) / 1920 ≈ 0.3164

function cropFractions(zoom: number) {
  const hFrac = Math.min(1, 1 / zoom)
  const wFrac = Math.min(1, CROP_W_AT_ZOOM_1 / zoom)
  return { wFrac, hFrac }
}

interface Crop { zoom: number; pos_x: number; pos_y: number }

export function PortraitCropEditor() {
  const stageRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [token, setToken] = useState<string | null>(null)
  const [crop, setCrop] = useState<Crop>({ zoom: 1, pos_x: 0.5, pos_y: 0.5 })
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    async function load() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      setToken(session.access_token)
      const res = await fetch('/api/portrait-crop', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const c = await res.json()
        setCrop({ zoom: c.zoom ?? 1, pos_x: c.pos_x ?? 0.5, pos_y: c.pos_y ?? 0.5 })
      }
      setLoaded(true)
    }
    load()
  }, [])

  const save = useCallback(async (next: Crop) => {
    if (!token) return
    const res = await fetch('/api/portrait-crop', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
    if (res.ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }
  }, [token])

  const { wFrac, hFrac } = cropFractions(crop.zoom)

  // Box position within the stage (top-left), derived from pos_x/pos_y.
  const leftPct = crop.pos_x * (1 - wFrac) * 100
  const topPct = crop.pos_y * (1 - hFrac) * 100

  const moveTo = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current
    if (!stage) return
    const r = stage.getBoundingClientRect()
    const { wFrac, hFrac } = cropFractions(crop.zoom)
    // Position the crop window so its center follows the pointer, then convert
    // back to a 0..1 position along the free travel.
    const cx = (clientX - r.left) / r.width
    const cy = (clientY - r.top) / r.height
    const px = wFrac >= 1 ? 0.5 : (cx - wFrac / 2) / (1 - wFrac)
    const py = hFrac >= 1 ? 0.5 : (cy - hFrac / 2) / (1 - hFrac)
    setCrop(c => ({ ...c, pos_x: clamp01(px), pos_y: clamp01(py) }))
  }, [crop.zoom])

  function onPointerDown(e: React.PointerEvent) {
    dragging.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    moveTo(e.clientX, e.clientY)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (dragging.current) moveTo(e.clientX, e.clientY)
  }
  function onPointerUp() {
    dragging.current = false
    save(crop)
  }

  if (!loaded) {
    return <div className="text-ink-faint text-sm py-4">Loading framing…</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-5 flex-col sm:flex-row">
        {/* 16:9 source stage with draggable 9:16 crop window */}
        <div
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="relative w-full sm:w-[360px] aspect-video rounded-lg overflow-hidden bg-bg border border-line cursor-move select-none shrink-0"
          style={{
            backgroundImage:
              'linear-gradient(135deg, rgba(124,92,252,0.12), rgba(124,92,252,0)), repeating-linear-gradient(0deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 28px), repeating-linear-gradient(90deg, rgba(255,255,255,0.04) 0 1px, transparent 1px 28px)',
          }}
        >
          {/* dimmed area outside crop */}
          <div className="absolute inset-0 bg-black/50 pointer-events-none" />
          {/* the crop window */}
          <div
            className="absolute border-2 border-brand bg-brand/10 pointer-events-none"
            style={{
              left: `${leftPct}%`,
              top: `${topPct}%`,
              width: `${wFrac * 100}%`,
              height: `${hFrac * 100}%`,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.0)',
            }}
          >
            <span className="absolute -top-5 left-0 text-[10px] font-mono text-brand whitespace-nowrap">
              9:16 vertical
            </span>
          </div>
          <span className="absolute bottom-1 right-2 text-[10px] font-mono text-ink-faint pointer-events-none">
            16:9 source
          </span>
        </div>

        {/* Controls */}
        <div className="flex-1 w-full space-y-4">
          <div>
            <div className="flex justify-between text-xs text-ink-muted mb-2">
              <span>Zoom</span>
              <span className="font-mono text-ink">{crop.zoom.toFixed(2)}×</span>
            </div>
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={crop.zoom}
              onChange={e => setCrop(c => ({ ...c, zoom: Number(e.target.value) }))}
              onMouseUp={() => save(crop)}
              onTouchEnd={() => save(crop)}
              className="w-full accent-brand"
            />
            <div className="flex justify-between text-xs text-ink-faint mt-1">
              <span>Fit height</span>
              <span>3× tight</span>
            </div>
          </div>

          <p className="text-xs text-ink-faint leading-relaxed">
            Drag the box to reposition the vertical crop. This framing is applied to
            every portrait platform. Keep your action inside the box — anything
            outside is cropped out.
          </p>

          <div className="flex items-center gap-3">
            <button
              onClick={() => { const reset = { zoom: 1, pos_x: 0.5, pos_y: 0.5 }; setCrop(reset); save(reset) }}
              className="text-xs text-ink-muted hover:text-ink transition-colors"
            >
              Reset to center
            </button>
            {saved && <span className="text-xs text-success">Saved ✓</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5
  return Math.min(1, Math.max(0, n))
}
