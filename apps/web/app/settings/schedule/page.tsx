import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getConfigValue } from '@sentinello/db'
import { ScheduleForm } from '@/components/settings/schedule-form'
import { getDb } from '@/lib/db'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('schedule.metaTitle') }
}

type ScheduleConfig = { intervalHours?: number; startHour?: number; timezone?: string }

const ALLOWED = [1, 3, 6, 12, 24] as const
type IntervalHours = (typeof ALLOWED)[number]

function coerceInterval(value: number | undefined): IntervalHours {
    if (value && (ALLOWED as readonly number[]).includes(value)) return value as IntervalHours
    return 24
}

function coerceStartHour(value: number | undefined): number {
    if (typeof value === 'number' && value >= 0 && value <= 23) return Math.trunc(value)
    return 0
}

// Default the picker to the worker/host timezone (where cron actually runs) when nothing is saved,
// so the displayed anchor is meaningful out of the box.
function hostTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
        return 'UTC'
    }
}

export default async function ScheduleSettingsPage() {
    const db = getDb()
    const saved = getConfigValue<ScheduleConfig>(db, 'schedule')
    return (
        <ScheduleForm
            initial={{
                intervalHours: coerceInterval(saved?.intervalHours),
                startHour: coerceStartHour(saved?.startHour),
                timezone: saved?.timezone || hostTimezone()
            }}
        />
    )
}
