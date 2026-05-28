import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { WhatsNewContent } from '@/components/settings/whats-new-content'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('whatsNew.metaTitle') }
}

export default function WhatsNewSettingsPage() {
    return <WhatsNewContent />
}
