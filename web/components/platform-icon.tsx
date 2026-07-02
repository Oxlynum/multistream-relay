import { cn } from "@/lib/utils"

export type PlatformKey = "twitch" | "youtube" | "kick" | "tiktok"

// Arcade neon remap. Kick's brand green (#53FC18) collides with the lime primary,
// so all four get a distinct neon that never competes with lime: purple / red /
// amber / cyan. (Lime is reserved for the SlimCast brand, never a platform.)
export const PLATFORM_META: Record<PlatformKey, { label: string; tint: string }> = {
  twitch: { label: "Twitch", tint: "#b44dff" },  // neon purple
  youtube: { label: "YouTube", tint: "#ff414d" }, // arcade red
  kick: { label: "Kick", tint: "#ffb400" },       // amber (remapped off clashing green)
  tiktok: { label: "TikTok", tint: "#22e8ff" },   // electric cyan
}

const PATHS: Record<PlatformKey, string> = {
  twitch:
    "M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z",
  youtube:
    "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12z",
  tiktok:
    "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z",
  kick:
    "M0 0h6.667v5.333h2.666V2.667h2.667V0H20v8h-2.667v2.667h-2.666v2.666H17.333V16H20v8h-6.667v-2.667h-2.666v-2.666H9.333V24H0z",
}

export function PlatformIcon({
  platform,
  className = "h-5 w-5",
}: {
  platform: PlatformKey
  className?: string
}) {
  const viewBox = platform === "kick" ? "0 0 20 24" : "0 0 24 24"
  return (
    <svg viewBox={viewBox} className={className} fill="currentColor" aria-hidden="true">
      <path d={PATHS[platform]} />
    </svg>
  )
}

/** Tinted pill with the platform's mark + label. */
export function PlatformBadge({
  platform,
  className,
}: {
  platform: PlatformKey
  className?: string
}) {
  const { label, tint } = PLATFORM_META[platform]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 border-2 px-3 py-1 font-mono text-sm font-medium",
        className,
      )}
      style={{ borderColor: `${tint}55`, color: tint, background: `${tint}14` }}
    >
      <PlatformIcon platform={platform} className="h-4 w-4" />
      {label}
    </span>
  )
}
