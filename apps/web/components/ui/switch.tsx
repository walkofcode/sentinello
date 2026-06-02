'use client'

import { cn } from '@/lib/cn'

type Props = {
    checked: boolean
    onCheckedChange: (next: boolean) => void
    disabled?: boolean
    id?: string
    'aria-label'?: string
    'aria-labelledby'?: string
}

// Accessible on/off toggle (role="switch"). Mirrors the look of a native switch — a pill track with a
// sliding knob — and is keyboard/AT-friendly via aria-checked. Used in Settings to enable opt-in sources.
export function Switch({ checked, onCheckedChange, disabled, id, ...rest }: Props) {
    return (
        <button
            type="button"
            role="switch"
            id={id}
            aria-checked={checked}
            disabled={disabled}
            onClick={function onClick() { onCheckedChange(!checked) }}
            className={cn(
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                'disabled:cursor-not-allowed disabled:opacity-50',
                checked ? 'bg-primary' : 'bg-muted-foreground/30'
            )}
            {...rest}
        >
            <span
                className={cn(
                    'inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                    checked ? 'translate-x-[18px]' : 'translate-x-0.5'
                )}
            />
        </button>
    )
}
