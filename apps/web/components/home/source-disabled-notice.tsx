import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { AlertTriangle } from 'lucide-react'
import { languageNames, type ProjectsWithoutSource } from '@/lib/project-state'

// Above the projects list: how many projects nothing scans because no source is enabled for their language.
// Python, Go, Rust and Ruby have no source on by default (OSV and gemnasium are opt-in), so on a fresh install
// this is the one place that says those projects are not being looked at, rather than leaving them to read
// as quiet. Counts every project, not the filtered list: it is about the install, not the current view.
export async function SourceDisabledNotice({ withoutSource }: { withoutSource: ProjectsWithoutSource }) {
    if (withoutSource.projects === 0) return null
    const t = await getTranslations('Home')
    const languages = languageNames(withoutSource.ecosystems.map(function id(entry) { return entry.ecosystem }))
    return (
        <div data-testid="source-disabled-notice" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-(--radius-card) border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>{t('sourceDisabledNotice', { count: withoutSource.projects, languages })}</span>
            <Link href="/settings/sources" className="font-medium underline underline-offset-4 hover:opacity-80">
                {t('sourceDisabledAction')}
            </Link>
        </div>
    )
}
