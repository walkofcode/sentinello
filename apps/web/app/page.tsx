import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getDashboardSummary, isAnyScanInFlight, listLibraries, listProjectCatalog } from '@sentinello/db'
import { SpyTarget } from '@/components/layout/scroll-spy-context'
import { OverviewSection } from '@/components/home/overview-section'
import { ProjectsSection } from '@/components/home/projects-section'
import { LibrariesSection } from '@/components/home/libraries-section'
import { ScanAutoRefresh } from '@/components/scan-auto-refresh'
import { getDb } from '@/lib/db'
import { getFilterDefaults, parseDepTypeParam } from '@/lib/filter-defaults'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Home')
    return { title: t('metaTitle') }
}

type SearchParams = Promise<{ pdep?: string; ldep?: string }>

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
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
        <div className="space-y-16">
            <ScanAutoRefresh active={anyInFlight} />
            <SpyTarget id="overview">
                <OverviewSection summary={summary} librariesCount={libraries.length} now={now} anyInFlight={anyInFlight} />
            </SpyTarget>
            <SpyTarget id="projects">
                <ProjectsSection rows={projects} depType={projDep} defaultDepType={defaults.depType} />
            </SpyTarget>
            <SpyTarget id="libraries">
                <LibrariesSection libraries={libraries} depType={libDep} defaultDepType={defaults.depType} />
            </SpyTarget>
        </div>
    )
}
