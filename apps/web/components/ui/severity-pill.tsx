import type { Severity } from '@sentinello/core'
import { cn } from '@/lib/cn'

type Size = 'default' | 'sm'

type Props = {
    variant: Severity
    count?: number
    size?: Size
    className?: string
}

const TONE_BG: Record<Severity, string> = {
    critical: 'bg-[color:var(--color-sev-critical)]',
    high: 'bg-[color:var(--color-sev-high)]',
    moderate: 'bg-[color:var(--color-sev-moderate)]',
    low: 'bg-[color:var(--color-sev-low)]',
    info: 'bg-[color:var(--color-sev-info)]'
}

const SIZE_CLASSES: Record<Size, { wrap: string; label: string; count: string }> = {
    default: {
        wrap: 'gap-2.5 px-3 py-1',
        label: 'text-xs font-semibold uppercase tracking-wider',
        count: 'text-sm font-semibold tabular-nums'
    },
    sm: {
        wrap: 'gap-1.5 px-2 py-0.5',
        label: 'text-[0.625rem] font-semibold uppercase tracking-wider',
        count: 'text-xs font-semibold tabular-nums'
    }
}

export function SeverityPill({ variant, count, size = 'default', className }: Props) {
    if (count === 0) return null
    const s = SIZE_CLASSES[size]
    return (
        <div
            className={cn(
                'inline-flex items-center rounded-md text-white',
                s.wrap,
                TONE_BG[variant],
                className
            )}
        >
            <span className={s.label}>{variant}</span>
            {count !== undefined && <span className={s.count}>{count}</span>}
        </div>
    )
}
