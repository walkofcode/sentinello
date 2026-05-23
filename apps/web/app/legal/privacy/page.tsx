import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import PrivacyPolicy from '@/components/legal/privacy-policy'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Legal')
    return { title: t('privacyTitle') }
}

export default function PrivacyPage() {
    return (
        <div className="mx-auto max-w-3xl">
            <PrivacyPolicy />
        </div>
    )
}
