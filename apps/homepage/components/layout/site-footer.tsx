import { getTranslations } from 'next-intl/server'
import { GITHUB_ISSUES_URL, GITHUB_URL, LICENSE_URL, WALKOFCODE_URL } from '@/lib/links'

export async function SiteFooter() {
    const t = await getTranslations('Footer')
    const year = new Date().getFullYear()
    return (
        <footer className="mt-auto border-t bg-card/40 px-4 py-6 text-xs text-muted-foreground">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-4 gap-y-2 text-center sm:justify-between">
                <span className="flex items-center gap-1.5">
                    <a
                        href={WALKOFCODE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold tracking-tight text-foreground/90 transition-colors hover:text-foreground"
                    >
                        Walk of Code LLC
                    </a>
                    <span className="text-muted-foreground/60">{t('copyright', { year })}</span>
                </span>
                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
                    <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground/80 transition-colors hover:text-foreground">
                        {t('github')}
                    </a>
                    <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground/80 transition-colors hover:text-foreground">
                        {t('issues')}
                    </a>
                    <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground/80 transition-colors hover:text-foreground">
                        {t('license')}
                    </a>
                </div>
            </div>
        </footer>
    )
}
