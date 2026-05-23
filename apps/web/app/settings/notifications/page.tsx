import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { listNotificationTargets, listProjects, listRoots } from '@sentinello/db'
import { NotificationTargetList } from '@/components/settings/notification-target-list'
import { getDb } from '@/lib/db'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('notifications.metaTitle') }
}

export default async function NotificationsSettingsPage() {
    const db = getDb()
    const targets = listNotificationTargets(db)
    const roots = listRoots(db)
    const projects = listProjects(db)
    return <NotificationTargetList targets={targets} roots={roots} projects={projects} />
}
