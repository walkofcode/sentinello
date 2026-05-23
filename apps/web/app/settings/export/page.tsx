import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getConfigValue } from '@sentinello/db'
import { ExportPromptForm } from '@/components/settings/export-prompt-form'
import { DEFAULT_EXPORT_PROMPT } from '@/lib/export-markdown'
import { getDb } from '@/lib/db'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('export.metaTitle') }
}

export default async function ExportSettingsPage() {
    const db = getDb()
    const stored = getConfigValue<string>(db, 'markdownExportPrompt')
    const initialPrompt = (stored && stored.trim().length > 0) ? stored : DEFAULT_EXPORT_PROMPT
    const isCustom = Boolean(stored && stored.trim().length > 0)
    return (
        <ExportPromptForm
            initialPrompt={initialPrompt}
            defaultPrompt={DEFAULT_EXPORT_PROMPT}
            isCustom={isCustom}
        />
    )
}
