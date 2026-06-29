import { cn } from "@/lib/utils"

const DOT_BG = {
  live: "bg-live",
  success: "bg-success",
  cyan: "bg-cyan",
  brand: "bg-brand",
  warning: "bg-warning",
} as const

/** Broadcast-style pulsing dot for live/status indicators. */
export function LiveDot({
  className,
  color = "live",
  size = 8,
}: {
  className?: string
  color?: keyof typeof DOT_BG
  size?: number
}) {
  const bg = DOT_BG[color]
  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <span className={cn("absolute inset-0 rounded-full animate-ping-slow", bg)} />
      <span
        className={cn("relative rounded-full", bg)}
        style={{ width: size, height: size }}
      />
    </span>
  )
}
