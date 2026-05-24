import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getDashboardSummary, isAnyScanInFlight, listLibraries, listProjectCatalog } from '@sentinello/db'
import { OverviewSection } from '@/components/home/overview-section'
import { ProjectsFilterView } from '@/components/home/projects-filter-view'
import { ScanAutoRefresh } from '@/components/scan-auto-refresh'
import { getDb } from '@/lib/db'
import { getFilterDefaults, parseDepTypeParam } from '@/lib/filter-defaults'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Home')
    return { title: t('projectsTitle') }
}

type SearchParams = Promise<{ pdep?: string; ldep?: string }>

export default async function ProjectsPage({ searchParams }: { searchParams: SearchParams }) {
    const db = getDb()
    const now = Date.now()
    const params = await searchParams
    const defaults = getFilterDefaults(db)
    const projDep = parseDepTypeParam(params.pdep) || defaults.depType
    const libDep = parseDepTypeParam(params.ldep) || defaults.depType
    const summary = getDashboardSummary(db, now, projDep)
    const projects = listProjectCatalog(db, now, projDep)
    const libraries = listLibraries(db, now, libDep)
    const anyInFlight = isAnyScanInFlight(db, now)
    return (
        <div className="space-y-6">
            <ScanAutoRefresh active={anyInFlight} />
            <ProjectsFilterView
                rows={projects}
                depType={projDep}
                defaultDepType={defaults.depType}
                belowFiltersSlot={
                    <OverviewSection
                        summary={summary}
                        librariesCount={libraries.length}
                        now={now}
                        anyInFlight={anyInFlight}
                    />
                }
            />
        </div>
    )
}
