import Link from 'next/link'

export function LogoMark({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      {/* broadcast / cast mark */}
      <circle cx="5.5" cy="18.5" r="2.4" fill="currentColor" />
      <path
        d="M4.5 11.2a9.3 9.3 0 0 1 8.3 8.3"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M4.5 5.2A15.3 15.3 0 0 1 18.8 19.5"
        stroke="currentColor"
        strokeWidth="2.1"
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
      <span className="text-accent">
        <LogoMark className="w-5 h-5" />
      </span>
      <span className="text-lg font-bold tracking-tight text-ink">SlimCast</span>
    </span>
  )
  if (href === null) return inner
  return (
    <Link href={href} className="inline-flex items-center hover:opacity-90 transition-opacity">
      {inner}
    </Link>
  )
}
