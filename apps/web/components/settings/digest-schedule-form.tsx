'use client'

import { useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import type { WeeklyDigestSchedule } from '@sentinello/core'
import { Label } from '@/components/ui/input'
import { Dropdown } from '@/components/ui/dropdown'
import { SaveStatus } from '@/components/settings/save-status'
import { updateWeeklyDigestScheduleAction } from '@/lib/actions/settings'

const DAYS = [1, 2, 3, 4, 5, 6, 0]
const HOURS = Array.from({ length: 24 }, function hour(_unused, i) { return i })

// A day of a week in the reader's language, off a Sunday no timezone can move.
function weekdayName(day: number, locale: string): string {
    return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 4 + day)))
}

type Props = {
    initial: WeeklyDigestSchedule
    timezone: string
}

// The weekly digest's one day and hour, for every target that has it on, in the schedule's timezone.
export function DigestScheduleForm({ initial, timezone }: Props) {
    const t = useTranslations('Settings')
    const locale = useLocale()
    const [day, setDay] = useState(initial.day)
    const [hour, setHour] = useState(initial.hour)
    const [pending, startTransition] = useTransition()
    const [savedAt, setSavedAt] = useState<number | null>(null)
    const [error, setError] = useState<string | null>(null)
    function persist(next: WeeklyDigestSchedule) {
        setError(null)
        startTransition(async function run() {
            const result = await updateWeeklyDigestScheduleAction(next)
            if (!result.ok) {
                setDay(initial.day)
                setHour(initial.hour)
                setError(result.errorText)
                return
            }
            setSavedAt(Date.now())
        })
    }
    return (
        <div className="space-y-3 rounded-(--radius-card) border bg-card p-6">
            <span className="text-sm font-medium">{t('notifications.digestSchedule.title')}</span>
            <div className="flex flex-col gap-3 sm:flex-row">
                <div className="flex flex-col gap-1 sm:w-48">
                    <Label htmlFor="digest-day">{t('notifications.digestSchedule.day')}</Label>
                    <Dropdown
                        id="digest-day"
                        className="w-full"
                        ariaLabel={t('notifications.digestSchedule.day')}
                        value={String(day)}
                        disabled={pending}
                        onChange={function onChange(v) {
                            setDay(Number(v))
                            persist({ day: Number(v), hour })
                        }}
                        options={DAYS.map(function option(d) { return { value: String(d), label: weekdayName(d, locale) } })}
                    />
                </div>
                <div className="flex flex-col gap-1 sm:w-32">
                    <Label htmlFor="digest-hour">{t('notifications.digestSchedule.hour')}</Label>
                    <Dropdown
                        id="digest-hour"
                        className="w-full"
                        ariaLabel={t('notifications.digestSchedule.hour')}
                        value={String(hour)}
                        disabled={pending}
                        onChange={function onChange(v) {
                            setHour(Number(v))
                            persist({ day, hour: Number(v) })
                        }}
                        options={HOURS.map(function option(h) { return { value: String(h), label: (h < 10 ? '0' + h : String(h)) + ':00' } })}
                    />
                </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('notifications.digestSchedule.help', { timezone })}</p>
            <SaveStatus pending={pending} saved={savedAt !== null} error={error} />
        </div>
    )
}
