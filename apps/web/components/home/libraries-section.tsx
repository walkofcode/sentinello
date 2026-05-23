import type { LibrarySummary } from '@sentinello/db'
import type { DepTypeFilter } from '@sentinello/core'
import { getTranslations } from 'next-intl/server'
import { LibrariesFilterView } from './libraries-filter-view'

type Props = {
    libraries: LibrarySummary[]
    depType: DepTypeFilter
    defaultDepType: DepTypeFilter
}

export async function LibrariesSection({ libraries, depType, defaultDepType }: Props) {
    const t = await getTranslations('Home')
    return (
        <div className="space-y-6">
            <header>
                <h2 className="text-2xl font-semibold tracking-tight">{t('librariesTitle')}</h2>
            </header>
            <LibrariesFilterView libraries={libraries} depType={depType} defaultDepType={defaultDepType} />
        </div>
    )
}
