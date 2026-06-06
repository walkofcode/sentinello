import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getActiveScanners, listActiveMutes, listLibraryUsage, listMuteLiftsForLibrary, listResolvedFindingsForLibrary } from '@sentinello/db'
import { type Severity } from '@sentinello/core'
import { advisoryIdentity } from '@/lib/merge-findings'
import { SeverityPill } from '@/components/ui/severity-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { ScrollToTop } from '@/components/layout/scroll-to-top'
import { DepTypeFilter } from '@/components/findings/dep-type-filter'
import { SourceFilter } from '@/components/findings/source-filter'
import { orderSources } from '@/components/findings/source-order'
import { LibraryFindingsSection } from '@/components/findings/library-findings-section'
import { LibraryResolvedTable } from '@/components/findings/library-resolved-table'
import { ExportAdvisoryButton } from '@/components/triage/export-advisory-button'
import { MuteLibraryEverywhereButton } from '@/components/triage/mute-library-everywhere-button'
import { MuteLiftsTable } from '@/components/triage/mute-lifts-table'
import { getDb } from '@/lib/db'
import { getFilterDefaults, parseDepTypeParam } from '@/lib/filter-defaults'

type PageProps = {
    params: Promise<{ name: string }>
    searchParams: Promise<{ dep?: string; src?: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const resolvedParams = await params
    return { title: decodeURIComponent(resolvedParams.name) }
}

export default async function LibraryDetailPage({ params, searchParams }: PageProps) {
    const resolvedParams = await params
    const resolvedSearchParams = await searchParams
    const t = await getTranslations('Detail')
    const db = getDb()
    const now = Date.now()
    const packageName = decodeURIComponent(resolvedParams.name)
    const defaults = getFilterDefaults(db)
    const depType = parseDepTypeParam(resolvedSearchParams.dep) || defaults.depType
    const enabledSources = orderSources(getActiveScanners(db))
    const usages = listLibraryUsage(db, packageName, now, depType)
    const resolvedFindings = listResolvedFindingsForLibrary(db, packageName, 50)
    const activeMutes = listActiveMutes(db, now)
    const muteLifts = listMuteLiftsForLibrary(db, packageName, 20)
    const distinctAdvisories = new Set(usages.map(function pickAdv(u) { return advisoryIdentity(u.advisoryTitle, u.advisoryId) })).size
    const distinctProjects = new Set(usages.map(function pickProj(u) { return u.projectId })).size
    const severityOrder: Severity[] = ['critical', 'high', 'moderate', 'low', 'info']
    const presentSeverities = severityOrder.filter(function present(s) {
        return usages.some(function has(u) { return u.severity === s })
    })
    const bulkRows = usages.map(function toRow(u) {
        return { projectId: u.projectId, scanner: u.scanner, advisoryId: u.advisoryId }
    })
    return (
        <div className="space-y-8">
            <ScrollToTop />
            <header className="space-y-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">{t('library.eyebrow')}</p>
                        <h1 className="mt-1 text-3xl font-semibold tracking-tight font-mono">{packageName}</h1>
                        <p className="mt-2 text-sm text-muted-foreground">
                            {t('library.advisoryCount', { count: distinctAdvisories })} · {t('library.projectCount', { count: distinctProjects })}
                        </p>
                        {presentSeverities.length > 0 ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                                {presentSeverities.map(function pill(s) {
                                    return <SeverityPill key={s} variant={s} size="sm" />
                                })}
                            </div>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <ExportAdvisoryButton scope="library" packageName={packageName} depType={depType} />
                        <MuteLibraryEverywhereButton
                            packageName={packageName}
                            rows={bulkRows}
                            totalRows={bulkRows.length}
                            disabled={bulkRows.length === 0}
                        />
                    </div>
                </div>
            </header>

            <section className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-lg font-semibold">{t('library.currentAdvisories', { count: usages.length })}</h2>
                    <div className="flex items-center gap-2">
                        <SourceFilter sources={enabledSources} />
                        <DepTypeFilter value={depType} defaultValue={defaults.depType} />
                    </div>
                </div>
                {usages.length === 0 ? (
                    <EmptyState
                        title={t('library.emptyTitle')}
                        description={t('library.emptyDescription')}
                    />
                ) : (
                    <LibraryFindingsSection
                        packageName={packageName}
                        usages={usages}
                        activeMutes={activeMutes}
                        now={now}
                        sources={enabledSources}
                    />
                )}
            </section>

            {resolvedFindings.length > 0 ? (
                <section className="space-y-3">
                    <div className="flex items-baseline justify-between">
                        <h2 className="text-lg font-semibold">{t('library.previouslyResolved', { count: resolvedFindings.length })}</h2>
                        <span className="text-xs text-muted-foreground">{t('library.mostRecent', { count: resolvedFindings.length })}</span>
                    </div>
                    <LibraryResolvedTable findings={resolvedFindings} now={now} />
                </section>
            ) : null}

            {muteLifts.length > 0 ? (
                <section className="space-y-3">
                    <div className="flex items-baseline justify-between">
                        <h2 className="text-lg font-semibold">{t('liftedMutes')}</h2>
                        <span className="text-xs text-muted-foreground">
                            {t('recentCount', { count: muteLifts.length })}
                        </span>
                    </div>
                    <MuteLiftsTable lifts={muteLifts} now={now} />
                </section>
            ) : null}
        </div>
    )
}
