'use client'

import { useTranslations } from 'next-intl'
import type { DepTypeFilter } from '@sentinello/core'

// Order chosen to match the prod-first reading on Settings → Defaults (filter-defaults-form): the
// most common case (Production) sits left, "Both" centered as the neutral default, "Development"
// trailing. The DepTypeFilter union value 'all' is the user-facing "Both".
const ENV_VALUES: DepTypeFilter[] = ['prod', 'all', 'dev']

type Props = {
    value: DepTypeFilter
    onChange: (value: DepTypeFilter) => void
    disabled?: boolean
}

export function EnvFilterField({ value, onChange, disabled }: Props) {
    const t = useTranslations('Settings')
    return (
        <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">{t('notifications.envFilter')}</label>
            <div className="grid gap-2 sm:grid-cols-3">
                {ENV_VALUES.map(function pick(option) {
                    const isSelected = value === option
                    return (
                        <button
                            key={option}
                            type="button"
                            disabled={disabled}
                            onClick={function choose() { onChange(option) }}
                            className={
                                'rounded-md border px-3 py-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ' +
                                (isSelected
                                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                    : 'border-border hover:bg-accent')
                            }
                        >
                            <div className="font-medium">{t('notifications.envFilterOption.' + option + '.label')}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {t('notifications.envFilterOption.' + option + '.description')}
                            </div>
                        </button>
                    )
                })}
            </div>
        </div>
    )
}
