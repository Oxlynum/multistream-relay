import Link from 'next/link'

const GRAD_ID = 'slimcast-aurora-mark'

export function LogoMark({
  className = 'h-6 w-6',
  gradient = true,
}: {
  className?: string
  gradient?: boolean
}) {
  const stroke = gradient ? `url(#${GRAD_ID})` : 'currentColor'
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      {gradient && (
        <defs>
          <linearGradient id={GRAD_ID} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7C5CFC" />
            <stop offset="46%" stopColor="#C247E6" />
            <stop offset="78%" stopColor="#FF5DA2" />
            <stop offset="100%" stopColor="#22D3EE" />
          </linearGradient>
        </defs>
      )}
      {/* broadcast node + outward waves */}
      <circle cx="9" cy="23" r="3" fill={stroke} />
      <path
        d="M7 14.5a11 11 0 0 1 10.5 10.5"
        stroke={stroke}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M7 7.5a18 18 0 0 1 17.5 17.5"
        stroke={stroke}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
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
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark className="h-6 w-6" />
      <span className="font-display text-lg font-bold tracking-tight text-ink">
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
