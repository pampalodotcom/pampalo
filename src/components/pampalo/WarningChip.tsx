import { cn } from '@/lib/utils'

export function WarningChip({
  children = 'Pampalo is Experimental',
  className,
}: {
  children?: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5',
        'border text-[11.5px] font-semibold tracking-[0.01em]',
        className,
      )}
      style={{
        background: 'var(--color-warn-bg)',
        borderColor: 'var(--color-warn-bd)',
        color: 'var(--color-warn-fg)',
      }}
    >
      <WarnTriangle className="size-3.5" />
      {children}
    </span>
  )
}

function WarnTriangle({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      aria-hidden
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M8 1.8 14.5 13H1.5L8 1.8z"
        fill="#d68a16"
        stroke="#8a5410"
        strokeWidth="0.8"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.5v3.2"
        stroke="#faf6ea"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.4" r="0.85" fill="#faf6ea" />
    </svg>
  )
}
