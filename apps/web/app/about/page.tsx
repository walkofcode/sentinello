import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { AboutContent } from '@/components/about/about-content'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('About')
    return { title: t('metaTitle') }
}

export default function AboutPage() {
    return <AboutContent />
}
