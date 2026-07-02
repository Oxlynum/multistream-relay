'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

function CountUp({ target, run, durationMs = 1100 }: { target: number; run: boolean; durationMs?: number }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!run) return
    let raf = 0
    let startTs = 0
    const tick = (ts: number) => {
      if (!startTs) startTs = ts
      const p = Math.min(1, (ts - startTs) / durationMs)
      const eased = 1 - Math.pow(1 - p, 3) // easeOutCubic
      setN(Math.round(eased * target))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [run, target, durationMs])
  // Plain digits (no thousands separator) so values like "1080p60" don't render "1,080p60".
  return <>{String(n)}</>
}

/** Stat tile: big aurora mono number (count-up on scroll into view) + label. */
export function StatTile({
  value,
  label,
  className,
}: {
  value: string
  label: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true)
      return
    }
    const ob = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShown(true)
          ob.disconnect()
        }
      },
      { threshold: 0.4 },
    )
    ob.observe(el)
    return () => ob.disconnect()
  }, [])

  const m = value.match(/^(\D*)(\d+)(.*)$/)

  return (
    <div
      ref={ref}
      className={cn(
        'rounded-2xl border border-line bg-surface p-6 transition-colors hover:border-line-strong',
        className,
      )}
    >
      <div className="text-aurora font-mono text-4xl font-semibold tracking-tight md:text-5xl">
        {m ? (
          <>
            {m[1]}
            <CountUp target={parseInt(m[2], 10)} run={shown} />
            {m[3]}
          </>
        ) : (
          value
        )}
      </div>
      <div className="mt-2 text-sm leading-relaxed text-ink-muted">{label}</div>
    </div>
  )
}
