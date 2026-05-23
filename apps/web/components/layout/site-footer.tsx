import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { getVersionInfo } from '@/lib/version'

// Rendered on every page via app/layout.tsx. Server component: calls getVersionInfo() directly
// (cached at module level — see lib/version.ts), so there's no client fetch + flash.

export async function SiteFooter() {
    const info = await getVersionInfo()
    const t = await getTranslations('Footer')
    return (
        <footer className="mt-auto border-t bg-card/40 px-4 py-3 text-xs text-muted-foreground">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center sm:justify-between">
                <a
                    href="https://sentinello.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-foreground/80 transition-colors hover:text-foreground"
                >
                    {t('version', { version: info.current })}
                </a>
                {info.updateAvailable && info.latest && (
                    <a
                        href={info.releaseUrl || 'https://github.com/walkofcode/sentinello/releases'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
                    >
                        {t('updateAvailable', { version: info.latest })}
                        <span aria-hidden="true">↗</span>
                    </a>
                )}
                <span className="text-muted-foreground/80">
                    {t('madeBy')}{' '}
                    <a
                        href="https://walkofcode.io"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-foreground/80 transition-colors hover:text-foreground"
                    >
                        Walk of Code LLC
                    </a>
                </span>
                <Link
                    href="/about"
                    className="font-medium text-foreground/80 transition-colors hover:text-foreground"
                >
                    {t('about')}
                </Link>
            </div>
            <div className="mx-auto mt-1 max-w-7xl text-center text-[11px] text-muted-foreground/70">
                {t.rich('legalNotice', {
                    terms: function terms(chunks) {
                        return <Link href="/legal/terms" className="underline hover:text-foreground">{chunks}</Link>
                    },
                    privacy: function privacy(chunks) {
                        return <Link href="/legal/privacy" className="underline hover:text-foreground">{chunks}</Link>
                    },
                    disclaimer: function disclaimer(chunks) {
                        return <Link href="/legal/disclaimer" className="underline hover:text-foreground">{chunks}</Link>
                    }
                })}
            </div>
        </footer>
    )
}
