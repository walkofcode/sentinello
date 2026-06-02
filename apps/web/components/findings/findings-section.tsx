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
import { SourceFilter, orderSources, parseSourceParam } from './source-filter'
import { mergeFindings } from '@/lib/merge-findings'

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
    const searchParams = useSearchParams()
    const [view, setView] = useState<View>('advisory')
    const [advisoryPage, setAdvisoryPage] = useState(1)
    const [libraryPage, setLibraryPage] = useState(1)

    // Sources present across all loaded rows (already narrowed to active sources server-side) and the
    // user's ?src= selection over them (empty = all). Filtering is pure presentation over loaded rows.
    const sources = useMemo(function present() {
        return orderSources(findings.map(function pick(f) { return f.scanner }))
    }, [findings])
    const selected = useMemo(function parse() {
        return parseSourceParam(searchParams.get('src'), sources)
    }, [searchParams, sources])

    // Collapse duplicate rows (same package@version reported via many dep-paths and by both sources)
    // into one row per vulnerability, carrying every source as a tag. The "by advisory" tab and its
    // count run off the merged list; "by library" keeps grouping the raw rows.
    const merged = useMemo(function build() {
        const all = mergeFindings(findings)
        // A merged vuln stays whole (every tag, best fix) as long as a selected source reports it.
        if (selected.length === 0) return all
        return all.filter(function keep(m) {
            return m.scanners.some(function sel(s) { return selected.includes(s) })
        })
    }, [findings, selected])
    const groups = useMemo(function build() {
        // The by-library tab groups raw rows, so filter rows to the selected source(s) before grouping.
        const rows = selected.length === 0
            ? findings
            : findings.filter(function keep(f) { return selected.includes(f.scanner) })
        return groupByLibrary(rows)
    }, [findings, selected])

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
                <SourceFilter sources={sources} selected={selected} />
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
