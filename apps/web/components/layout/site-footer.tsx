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
        </footer>
    )
}
