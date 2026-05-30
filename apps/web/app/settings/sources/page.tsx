import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getConfigValue } from '@sentinello/db'
import { SOURCE_CONFIG_KEYS, type OsvSourceStatus } from '@sentinello/core'
import { SourcesForm } from '@/components/settings/sources-form'
import { getDb } from '@/lib/db'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('sources.metaTitle') }
}

export default async function SourcesSettingsPage() {
    const db = getDb()
    const osvEnabled = getConfigValue<boolean>(db, SOURCE_CONFIG_KEYS.osvEnabled) === true
    const status = getConfigValue<OsvSourceStatus>(db, SOURCE_CONFIG_KEYS.osvStatus)
    return <SourcesForm osvEnabled={osvEnabled} status={status} />
}
