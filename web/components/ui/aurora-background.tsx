import { cn } from "@/lib/utils"

/** Ambient drifting aurora glow behind a section. Reserve for hero + final CTA. */
export function AuroraBackground({
  children,
  className,
  as: Tag = "div",
}: {
  children: React.ReactNode
  className?: string
  as?: React.ElementType
}) {
  return <Tag className={cn("aurora-bg", className)}>{children}</Tag>
}
