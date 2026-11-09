import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getConfigValue, getWeeklyDigestSchedule, listNotificationTargets, listProjects, listRoots } from '@sentinello/db'
import { DigestScheduleForm } from '@/components/settings/digest-schedule-form'
import { NotificationTargetList } from '@/components/settings/notification-target-list'
import { getDb } from '@/lib/db'
import { hostTimezone } from '@/lib/host-timezone'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('notifications.metaTitle') }
}

export default async function NotificationsSettingsPage() {
    const db = getDb()
    const targets = listNotificationTargets(db)
    const roots = listRoots(db)
    const projects = listProjects(db)
    const timezone = getConfigValue<{ timezone?: string }>(db, 'schedule')?.timezone || hostTimezone()
    return (
        <div className="space-y-6">
            <NotificationTargetList targets={targets} roots={roots} projects={projects} />
            <DigestScheduleForm initial={getWeeklyDigestSchedule(db)} timezone={timezone} />
        </div>
    )
}
