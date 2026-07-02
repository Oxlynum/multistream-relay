'use client'

import { useSyncExternalStore, useCallback } from 'react'
import { cn } from '@/lib/utils'

const KEY = 'slimcast-scanlines'
const CLASS = 'crt-scanlines'

// Cross-instance sync so toggling in one nav updates the toggle in the other.
const listeners = new Set<() => void>()
function subscribe(cb: () => void) {
  listeners.add(cb)
  window.addEventListener('storage', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', cb)
  }
}
function getSnapshot() {
  return document.documentElement.classList.contains(CLASS)
}
function getServerSnapshot() {
  return true // default ON (matches the pre-paint script in app/layout.tsx)
}

/**
 * The single user-facing CRT control: scanlines on/off. State lives on <html>
 * (class toggled here + by the pre-paint layout script) and in localStorage.
 * useSyncExternalStore reads it without an effect → no hydration mismatch, no
 * setState-in-effect, and every mounted toggle stays in sync.
 */
export function ScanlineToggle({ className }: { className?: string }) {
  const on = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const toggle = useCallback(() => {
    const next = !document.documentElement.classList.contains(CLASS)
    document.documentElement.classList.toggle(CLASS, next)
    try {
      localStorage.setItem(KEY, next ? '1' : '0')
    } catch {
      /* ignore */
    }
    listeners.forEach(l => l())
  }, [])

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      title="Toggle CRT scanlines"
      className={cn(
        'font-pixel inline-flex items-center gap-1 border-2 border-line bg-surface px-2 py-1 text-[8px] uppercase leading-none text-ink-muted transition-colors hover:border-brand hover:text-brand',
        className,
      )}
    >
      CRT<span aria-hidden="true">{on ? '▓' : '░'}</span>
    </button>
  )
}
