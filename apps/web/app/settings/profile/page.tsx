import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { ProfileForm } from '@/components/settings/profile-form'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('profile.metaTitle') }
}

export default function SettingsProfilePage() {
    return <ProfileForm />
}
