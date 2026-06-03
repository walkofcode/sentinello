import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { ProfileForm } from '@/components/settings/profile-form'
import { Button } from '@/components/ui/button'
import { isPortalAuthEnabled } from '@/lib/portal-auth'
import { logoutAction } from '@/app/login/actions'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('profile.metaTitle') }
}

export default function SettingsProfilePage() {
    return (
        <div className="flex flex-col gap-8">
            <ProfileForm />
            {isPortalAuthEnabled() ? (
                <section className="rounded-lg border p-4">
                    <h2 className="text-sm font-semibold">Session</h2>
                    <p className="mt-1 mb-3 text-sm text-muted-foreground">
                        Portal login is enabled. Sign out to clear your session on this browser.
                    </p>
                    <form action={logoutAction}>
                        <Button type="submit" variant="outline">Sign out</Button>
                    </form>
                </section>
            ) : null}
        </div>
    )
}
