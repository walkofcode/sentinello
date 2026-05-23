import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { FilterDefaultsForm } from '@/components/settings/filter-defaults-form'
import { getDb } from '@/lib/db'
import { getFilterDefaults } from '@/lib/filter-defaults'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('defaults.metaTitle') }
}

export default async function DefaultsSettingsPage() {
    const db = getDb()
    const defaults = getFilterDefaults(db)
    return <FilterDefaultsForm initial={defaults} />
}
