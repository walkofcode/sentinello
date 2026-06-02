'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { updateScheduleAction } from '@/lib/actions/settings'

const INTERVALS = [1, 3, 6, 12, 24] as const
type IntervalHours = (typeof INTERVALS)[number]

const HOURS = Array.from({ length: 24 }, function hour(_unused, i) { return i })

// IANA zone list from the runtime when available (evergreen browsers / Node 18+), falling back to
// just the current value so the control always renders something selectable.
function timezoneOptions(current: string): string[] {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
    const list = typeof supported === 'function' ? supported('timeZone') : []
    if (list.length === 0) return [current]
    if (!list.includes(current)) return [current, ...list]
    return list
}

type Props = {
    initial: { intervalHours: IntervalHours; startHour: number; timezone: string }
}

export function ScheduleForm({ initial }: Props) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const [intervalHours, setIntervalHours] = useState<IntervalHours>(initial.intervalHours)
    const [startHour, setStartHour] = useState<number>(initial.startHour)
    const [timezone, setTimezone] = useState<string>(initial.timezone)
    const [pending, startTransition] = useTransition()
    const [savedAt, setSavedAt] = useState<number | null>(null)
    const zones = timezoneOptions(initial.timezone)
    function persist(hours: IntervalHours, anchor: number, tz: string) {
        startTransition(async function run() {
            await updateScheduleAction(hours, anchor, tz)
            setSavedAt(Date.now())
        })
    }
    function choose(hours: IntervalHours) {
        if (hours === intervalHours) return
        setIntervalHours(hours)
        persist(hours, startHour, timezone)
    }
    function chooseStartHour(hour: number) {
        if (hour === startHour) return
        setStartHour(hour)
        persist(intervalHours, hour, timezone)
    }
    function chooseTimezone(tz: string) {
        if (tz === timezone) return
        setTimezone(tz)
        persist(intervalHours, startHour, tz)
    }
    // 1h fires every hour, so an anchor is meaningless there.
    const showStartHour = intervalHours !== 1
    return (
        <div className="space-y-4 rounded-(--radius-card) border bg-card p-6">
            <div className="flex flex-col gap-3">
                <span className="text-sm font-medium">{t('schedule.scanEvery')}</span>
                <div className="flex flex-wrap gap-2">
                    {INTERVALS.map(function pickInterval(hours) {
                        const isSelected = intervalHours === hours
                        return (
                            <Button
                                key={hours}
                                type="button"
                                variant={isSelected && 'default' || 'outline'}
                                disabled={pending}
                                onClick={function pick() { choose(hours) }}
                            >
                                {hours + 'h'}
                            </Button>
                        )
                    })}
                </div>
                <p className="text-xs text-muted-foreground">
                    {t('schedule.cadenceHelp')}
                </p>
            </div>
            {showStartHour ? (
                <div className="flex flex-col gap-2">
                    <Label htmlFor="schedule-start-hour">{t('schedule.startHour')}</Label>
                    <div className="flex flex-col sm:w-40">
                        <Select
                            id="schedule-start-hour"
                            value={String(startHour)}
                            disabled={pending}
                            onChange={function onChange(e) { chooseStartHour(Number(e.target.value)) }}
                        >
                            {HOURS.map(function option(h) {
                                const label = (h < 10 ? '0' + h : String(h)) + ':00'
                                return (
                                    <option key={h} value={String(h)}>
                                        {label}
                                    </option>
                                )
                            })}
                        </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {t('schedule.startHourHelp')}
                    </p>
                    <Label htmlFor="schedule-timezone" className="mt-2">{t('schedule.timezone')}</Label>
                    <div className="flex flex-col sm:w-72">
                        <Select
                            id="schedule-timezone"
                            value={timezone}
                            disabled={pending}
                            onChange={function onChange(e) { chooseTimezone(e.target.value) }}
                        >
                            {zones.map(function option(tz) {
                                return (
                                    <option key={tz} value={tz}>
                                        {tz}
                                    </option>
                                )
                            })}
                        </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {t('schedule.timezoneHelp')}
                    </p>
                </div>
            ) : null}
            <div className="h-4 text-xs text-muted-foreground" aria-live="polite">
                {pending ? tc('saving') : (savedAt ? tc('saved') : '')}
            </div>
        </div>
    )
}
