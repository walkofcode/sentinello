import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import Disclaimer from '@/components/legal/disclaimer'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Legal')
    return { title: t('disclaimerTitle') }
}

export default function DisclaimerPage() {
    return (
        <div className="mx-auto max-w-3xl">
            <Disclaimer />
        </div>
    )
}
