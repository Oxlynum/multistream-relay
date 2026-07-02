import Link from 'next/link'
import Image from 'next/image'

// intrinsic size of public/logo-mark.png (compact lockup) — CSS controls rendered size
const MARK_W = 100
const MARK_H = 80

export function LogoMark({
  className = 'h-6 w-6',
}: {
  className?: string
  /** @deprecated no longer used — kept so existing call sites don't break */
  gradient?: boolean
}) {
  return (
    <Image
      src="/logo-mark.png"
      alt=""
      width={MARK_W}
      height={MARK_H}
      className={`${className} w-auto object-contain`}
      priority
    />
  )
}

export function Logo({
  href = '/',
  className = '',
}: {
  href?: string | null
  className?: string
}) {
  const inner = (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <LogoMark className="h-14 sm:h-20" />
      <span className="font-pixel text-[18px] leading-none tracking-tight text-ink sm:text-[30px]">
        SlimCast
      </span>
    </span>
  )
  if (href === null) return inner
  return (
    <Link
      href={href}
      className="inline-flex items-center transition-opacity hover:opacity-90"
    >
      {inner}
    </Link>
  )
}
