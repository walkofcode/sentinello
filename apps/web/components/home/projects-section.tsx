import type { ProjectCatalogRow } from '@sentinello/db'
import type { DepTypeFilter } from '@sentinello/core'
import { getTranslations } from 'next-intl/server'
import { ProjectsFilterView } from './projects-filter-view'

type Props = {
    rows: ProjectCatalogRow[]
    depType: DepTypeFilter
    defaultDepType: DepTypeFilter
}

export async function ProjectsSection({ rows, depType, defaultDepType }: Props) {
    const t = await getTranslations('Home')
    return (
        <div className="space-y-6">
            <header>
                <h2 className="text-2xl font-semibold tracking-tight">{t('projectsTitle')}</h2>
            </header>
            <ProjectsFilterView rows={rows} depType={depType} defaultDepType={defaultDepType} />
        </div>
    )
}
