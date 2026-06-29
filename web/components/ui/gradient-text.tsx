import { cn } from "@/lib/utils"

/** Aurora gradient text — the signature brand device. Use sparingly (1-2 per viewport). */
export function GradientText({
  children,
  className,
  as: Tag = "span",
}: {
  children: React.ReactNode
  className?: string
  as?: React.ElementType
}) {
  return <Tag className={cn("text-aurora", className)}>{children}</Tag>
}
