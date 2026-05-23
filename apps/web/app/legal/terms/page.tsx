import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import Terms from '@/components/legal/terms'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Legal')
    return { title: t('termsTitle') }
}

export default function TermsPage() {
    return (
        <div className="mx-auto max-w-3xl">
            <Terms />
        </div>
    )
}
