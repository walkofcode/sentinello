'use client'

import { useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { CurrentFindingRow } from '@sentinello/db'
import type { Mute } from '@sentinello/core'
import { Tabs } from '@/components/ui/tabs'
import { Pagination } from '@/components/ui/pagination'
import { FindingsTable } from './findings-table'
import { LibrariesTable } from './libraries-table'
import { groupByLibrary } from './group-by-library'
import { parseEcosystemParam, parseSourceParam } from './source-order'
import { mergeFindings } from '@/lib/merge-findings'

type View = 'advisory' | 'library'

type Props = {
    findings: CurrentFindingRow[]
    projectId: string
    mutes: Mute[]
    now: number
    // Enabled sources (npm-audit always on, OSV when configured), in display order — the filter universe.
    sources: string[]
    // Ecosystems present in these findings, in display order — the language-filter universe. Optional;
    // when absent or single, no ecosystem filtering applies (e.g. the ecosystem-scoped library page).
    ecosystems?: string[]
}

const PAGE_SIZE = 25

export function FindingsSection({ findings, projectId, mutes, now, sources, ecosystems }: Props) {
    const t = useTranslations('Findings')
    const searchParams = useSearchParams()
    const [view, setView] = useState<View>('advisory')
    const [advisoryPage, setAdvisoryPage] = useState(1)
    const [libraryPage, setLibraryPage] = useState(1)

    const ecosystemUniverse = ecosystems ?? []

    // The user's ?src= selection over the enabled sources (empty = all). Filtering is pure presentation
    // over loaded rows — the universe is the enabled sources, not just those present, so "npm only" can
    // resolve to an empty table on a project where only OSV fired.
    const selected = useMemo(function parse() {
        return parseSourceParam(searchParams.get('src'), sources)
    }, [searchParams, sources])

    // The user's ?eco= selection over the present ecosystems (empty = all). Same pure-presentation model
    // as the source filter.
    const selectedEcosystems = useMemo(function parse() {
        return parseEcosystemParam(searchParams.get('eco'), ecosystemUniverse)
    }, [searchParams, ecosystemUniverse])

    // Collapse duplicate rows (same package@version reported via many dep-paths and by both sources)
    // into one row per vulnerability, carrying every source as a tag. The "by advisory" tab and its
    // count run off the merged list; "by library" keeps grouping the raw rows.
    const merged = useMemo(function build() {
        const all = mergeFindings(findings)
        return all.filter(function keep(m) {
            // A merged vuln stays whole (every tag, best fix) as long as a selected source reports it.
            if (selected.length > 0 && !m.scanners.some(function sel(s) { return selected.includes(s) })) return false
            // A merged row is ecosystem-pure (issue-019), so filter on its single ecosystem.
            if (selectedEcosystems.length > 0 && !selectedEcosystems.includes(m.ecosystem)) return false
            return true
        })
    }, [findings, selected, selectedEcosystems])
    const groups = useMemo(function build() {
        // The by-library tab groups raw rows, so filter rows to the selected source(s)/ecosystem(s) first.
        const rows = findings.filter(function keep(f) {
            if (selected.length > 0 && !selected.includes(f.scanner)) return false
            if (selectedEcosystems.length > 0 && !selectedEcosystems.includes(f.ecosystem)) return false
            return true
        })
        return groupByLibrary(rows)
    }, [findings, selected, selectedEcosystems])

    const advisoryTotalPages = Math.max(1, Math.ceil(merged.length / PAGE_SIZE))
    const libraryTotalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE))

    // Clamp current pages if data shrinks (e.g. after mute).
    const currentAdvisoryPage = Math.min(advisoryPage, advisoryTotalPages)
    const currentLibraryPage = Math.min(libraryPage, libraryTotalPages)

    const pagedFindings = useMemo(function slice() {
        const start = (currentAdvisoryPage - 1) * PAGE_SIZE
        return merged.slice(start, start + PAGE_SIZE)
    }, [merged, currentAdvisoryPage])

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
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Tabs
                    ariaLabel={t('groupingAriaLabel')}
                    value={view}
                    onChange={changeView}
                    tabs={[
                        { value: 'advisory', label: t('byAdvisory'), count: merged.length },
                        { value: 'library', label: t('byLibrary'), count: groups.length }
                    ]}
                />
            </div>
            {view === 'advisory' ? (
                <>
                    <FindingsTable findings={pagedFindings} projectId={projectId} mutes={mutes} now={now} />
                    <Pagination
                        page={currentAdvisoryPage}
                        totalPages={advisoryTotalPages}
                        totalItems={merged.length}
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
