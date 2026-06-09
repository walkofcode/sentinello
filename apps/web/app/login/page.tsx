import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { isPortalAuthEnabled } from '@/lib/portal-auth'
import { LoginForm } from './login-form'

export const dynamic = 'force-dynamic'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
    if (!isPortalAuthEnabled()) redirect('/')
    const params = await searchParams
    const next = typeof params.next === 'string' ? params.next : '/'
    const t = await getTranslations('Login')
    return (
        <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center px-4">
            <div className="rounded-lg border bg-card p-6 shadow-sm">
                <h1 className="text-xl font-semibold">Sentinello</h1>
                <p className="mt-1 mb-5 text-sm text-muted-foreground">{t('protected')}</p>
                <LoginForm next={next} />
            </div>
        </div>
    )
}
