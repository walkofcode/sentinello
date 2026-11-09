'use client'

import { useTranslations } from 'next-intl'
import type { TargetDelivery } from '@sentinello/core'

type Props = {
    delivery: TargetDelivery
    weeklyDigest: boolean
    onDeliveryChange: (delivery: TargetDelivery) => void
    onWeeklyDigestChange: (on: boolean) => void
    disabled?: boolean
}

// How a target hears about things: the same two controls when adding one and editing one. Each input sits inside its
// label with no id, because the edit form renders twice (the table and the mobile cards) and a duplicate id would
// point a label at the hidden copy.
export function TargetDeliveryFields({ delivery, weeklyDigest, onDeliveryChange, onWeeklyDigestChange, disabled }: Props) {
    const t = useTranslations('Settings')
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={delivery === 'run_summary'}
                        disabled={disabled}
                        onChange={function onChange(e) { onDeliveryChange(e.target.checked ? 'run_summary' : 'per_project') }}
                        className="h-4 w-4"
                    />
                    {t('notifications.runSummary')}
                </label>
                <p className="text-xs text-muted-foreground">{t('notifications.runSummaryHelp')}</p>
            </div>
            <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={weeklyDigest}
                        disabled={disabled}
                        onChange={function onChange(e) { onWeeklyDigestChange(e.target.checked) }}
                        className="h-4 w-4"
                    />
                    {t('notifications.weeklyDigest')}
                </label>
                <p className="text-xs text-muted-foreground">{t('notifications.weeklyDigestHelp')}</p>
            </div>
        </div>
    )
}
