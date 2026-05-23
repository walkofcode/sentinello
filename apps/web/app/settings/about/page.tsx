import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { AboutContent } from '@/components/about/about-content'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('about.metaTitle') }
}

export default function SettingsAboutPage() {
    return <AboutContent />
}
