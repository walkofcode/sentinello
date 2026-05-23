'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { CurrentFindingRow } from '@sentinello/db'
import type { Mute } from '@sentinello/core'
import { Tabs } from '@/components/ui/tabs'
import { Pagination } from '@/components/ui/pagination'
import { FindingsTable } from './findings-table'
import { LibrariesTable } from './libraries-table'
import { groupByLibrary } from './group-by-library'

type View = 'advisory' | 'library'

type Props = {
    findings: CurrentFindingRow[]
    projectId: string
    mutes: Mute[]
    now: number
}

const PAGE_SIZE = 25

export function FindingsSection({ findings, projectId, mutes, now }: Props) {
    const t = useTranslations('Findings')
    const [view, setView] = useState<View>('advisory')
    const [advisoryPage, setAdvisoryPage] = useState(1)
    const [libraryPage, setLibraryPage] = useState(1)

    const groups = useMemo(function build() { return groupByLibrary(findings) }, [findings])

    const advisoryTotalPages = Math.max(1, Math.ceil(findings.length / PAGE_SIZE))
    const libraryTotalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE))

    // Clamp current pages if data shrinks (e.g. after mute).
    const currentAdvisoryPage = Math.min(advisoryPage, advisoryTotalPages)
    const currentLibraryPage = Math.min(libraryPage, libraryTotalPages)

    const pagedFindings = useMemo(function slice() {
        const start = (currentAdvisoryPage - 1) * PAGE_SIZE
        return findings.slice(start, start + PAGE_SIZE)
    }, [findings, currentAdvisoryPage])

    const pagedGroupFindings = useMemo(function slice() {
        const start = (currentLibraryPage - 1) * PAGE_SIZE
        const pageGroups = groups.slice(start, start + PAGE_SIZE)
        const out: CurrentFindingRow[] = []
        for (const g of pageGroups) {
            for (const f of g.findings) out.push(f)
        }
        return out
    }, [groups, currentLibraryPage])

    function changeView(v: string) {
        setView(v as View)
    }

    return (
        <div className="space-y-3">
            <Tabs
                ariaLabel={t('groupingAriaLabel')}
                value={view}
                onChange={changeView}
                tabs={[
                    { value: 'advisory', label: t('byAdvisory'), count: findings.length },
                    { value: 'library', label: t('byLibrary'), count: groups.length }
                ]}
            />
            {view === 'advisory' ? (
                <>
                    <FindingsTable findings={pagedFindings} projectId={projectId} mutes={mutes} now={now} />
                    <Pagination
                        page={currentAdvisoryPage}
                        totalPages={advisoryTotalPages}
                        totalItems={findings.length}
                        pageSize={PAGE_SIZE}
                        itemLabel="finding"
                        onChange={setAdvisoryPage}
                    />
                </>
            ) : (
                <>
                    <LibrariesTable findings={pagedGroupFindings} projectId={projectId} mutes={mutes} now={now} />
                    <Pagination
                        page={currentLibraryPage}
                        totalPages={libraryTotalPages}
                        totalItems={groups.length}
                        pageSize={PAGE_SIZE}
                        itemLabel="library"
                        onChange={setLibraryPage}
                    />
                </>
            )}
        </div>
    )
}
