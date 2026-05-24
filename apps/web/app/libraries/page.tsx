import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { isAnyScanInFlight, listLibraries } from '@sentinello/db'
import { LibrariesFilterView } from '@/components/home/libraries-filter-view'
import { ScanAutoRefresh } from '@/components/scan-auto-refresh'
import { getDb } from '@/lib/db'
import { getFilterDefaults, parseDepTypeParam } from '@/lib/filter-defaults'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Home')
    return { title: t('librariesTitle') }
}

type SearchParams = Promise<{ ldep?: string }>

export default async function LibrariesPage({ searchParams }: { searchParams: SearchParams }) {
    const db = getDb()
    const now = Date.now()
    const params = await searchParams
    const defaults = getFilterDefaults(db)
    const libDep = parseDepTypeParam(params.ldep) || defaults.depType
    const libraries = listLibraries(db, now, libDep)
    const anyInFlight = isAnyScanInFlight(db, now)
    return (
        <div className="space-y-6">
            <ScanAutoRefresh active={anyInFlight} />
            <LibrariesFilterView libraries={libraries} depType={libDep} defaultDepType={defaults.depType} />
        </div>
    )
}
