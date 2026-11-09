'use client'

import { useTranslations } from 'next-intl'
import { TARGET_SEVERITY_VALUES, type Severity } from '@sentinello/core'
import { SeverityPill } from '@/components/ui/severity-pill'

type Props = {
    value: Severity[]
    onToggle: (sev: Severity) => void
    disabled?: boolean
}

// Severity toggles built from the same SeverityPill used everywhere findings are shown (solid
// severity colour). Selected = full colour; unselected = greyed/dimmed. Buttons (aria-pressed) so the
// colour carries the on/off state. There is no pill for `unrated`: a stored filter never holds it, and moderate
// covers it, which is what its label says.
export function SeverityFilterPills({ value, onToggle, disabled }: Props) {
    const t = useTranslations('Settings')
    return (
        <div className="flex flex-wrap items-center gap-2">
            {TARGET_SEVERITY_VALUES.map(function pill(s) {
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
                        <SeverityPill variant={s} size="sm" className="cursor-pointer" label={s === 'moderate' ? t('severityModerateAndUnrated') : undefined} />
                    </button>
                )
            })}
        </div>
    )
}
