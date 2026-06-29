import { cn } from "@/lib/utils"

/** Mono uppercase eyebrow label with a leading brand bar — the "creator energy" section tag. */
export function Kicker({
  children,
  className,
  color = "brand",
}: {
  children: React.ReactNode
  className?: string
  color?: "brand" | "cyan" | "pink"
}) {
  const colorClass =
    color === "cyan" ? "text-cyan" : color === "pink" ? "text-pink" : "text-brand"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-[0.2em]",
        colorClass,
        className,
      )}
    >
      <span aria-hidden className="inline-block h-3 w-[3px] rounded-full bg-current" />
      {children}
    </span>
  )
}
