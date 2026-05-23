'use client'

import type { Severity } from '@sentinello/core'
import { SeverityPill } from '@/components/ui/severity-pill'

const SEVERITIES: Severity[] = ['critical', 'high', 'moderate', 'low', 'info']

type Props = {
    value: Severity[]
    onToggle: (sev: Severity) => void
    disabled?: boolean
}

// Severity toggles built from the same SeverityPill used everywhere findings are shown (solid
// severity colour). Selected = full colour; unselected = greyed/dimmed. Buttons (aria-pressed) so the
// colour carries the on/off state.
export function SeverityFilterPills({ value, onToggle, disabled }: Props) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            {SEVERITIES.map(function pill(s) {
                const checked = value.includes(s)
                return (
                    <button
                        key={s}
                        type="button"
                        aria-pressed={checked}
                        disabled={disabled}
                        onClick={function toggle() { onToggle(s) }}
                        className={'rounded-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed ' +
                            (checked ? '' : 'opacity-40 grayscale')}
                    >
                        <SeverityPill variant={s} size="sm" className="cursor-pointer" />
                    </button>
                )
            })}
        </div>
    )
}
