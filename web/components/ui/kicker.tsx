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
        "inline-flex items-center gap-2 font-pixel text-[0.6rem] uppercase tracking-normal",
        colorClass,
        className,
      )}
    >
      <span aria-hidden className="inline-block h-2 w-2 bg-current" />
      {children}
    </span>
  )
}
