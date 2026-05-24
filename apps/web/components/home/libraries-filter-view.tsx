'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useTranslations } from 'next-intl'
import type { LibrarySummary } from '@sentinello/db'
import type { DepTypeFilter, Severity } from '@sentinello/core'
import { Card } from '@/components/ui/card'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { rememberLibrariesUrl } from '@/lib/home-url-memory'

type SortKey = 'severity' | 'name' | 'projects' | 'advisories'

type MinSeverity = '' | Severity

const SEVERITY_RANK: Record<string, number> = {
    critical: 0,
    high: 1,
    moderate: 2,
    low: 3,
    info: 4
}

const MIN_SEVERITY_OPTIONS: { value: MinSeverity; labelKey: string }[] = [
    { value: '', labelKey: 'severityAny' },
    { value: 'critical', labelKey: 'severityCriticalOnly' },
    { value: 'high', labelKey: 'severityHighPlus' },
    { value: 'moderate', labelKey: 'severityModeratePlus' },
    { value: 'low', labelKey: 'severityLowPlus' }
]

const SORT_OPTIONS: { value: SortKey; labelKey: string }[] = [
    { value: 'severity', labelKey: 'sortSeverity' },
    { value: 'name', labelKey: 'sortName' },
    { value: 'projects', labelKey: 'sortMostProjects' },
    { value: 'advisories', labelKey: 'sortMostAdvisories' }
]

const DEP_TYPE_OPTIONS: { value: DepTypeFilter; labelKey: string }[] = [
    { value: 'prod', labelKey: 'depProdOnly' },
    { value: 'dev', labelKey: 'depDevOnly' },
    { value: 'all', labelKey: 'depAll' }
]

type Props = {
    libraries: LibrarySummary[]
    depType: DepTypeFilter
    defaultDepType: DepTypeFilter
}

export function LibrariesFilterView({ libraries, depType, defaultDepType }: Props) {
    const t = useTranslations('Home')
    const router = useRouter()
    const [query, setQuery] = useState<string>('')
    const [minSeverity, setMinSeverity] = useState<MinSeverity>('')
    const [sort, setSort] = useState<SortKey>('severity')
    const hydratedRef = useRef<boolean>(false)

    function onDepTypeChange(next: DepTypeFilter) {
        const params = new URLSearchParams(window.location.search)
        if (next === defaultDepType) params.delete('ldep')
        else params.set('ldep', next)
        const search = params.toString()
        const url = window.location.pathname + (search && '?' + search) + window.location.hash
        router.replace(url, { scroll: false })
    }

    // Hydrate from URL once on client mount (avoids SSR/CSR mismatch).
    useEffect(function hydrateFromUrl() {
        const parsed = parseLibraryFiltersFromSearch(window.location.search)
        if (parsed.query !== undefined) setQuery(parsed.query)
        if (parsed.minSeverity !== undefined) setMinSeverity(parsed.minSeverity)
        if (parsed.sort !== undefined) setSort(parsed.sort)
        hydratedRef.current = true
    }, [])

    // Sync state back to URL via replaceState; remember it for the back button.
    useEffect(function syncUrl() {
        if (!hydratedRef.current) return
        const params = mergeLibraryFiltersIntoParams(new URLSearchParams(window.location.search), {
            query, minSeverity, sort
        })
        const search = params.toString()
        const next = window.location.pathname + (search && '?' + search) + window.location.hash
        window.history.replaceState(window.history.state, '', next)
        rememberLibrariesUrl(next)
    }, [query, minSeverity, sort])

    const filtered = useMemo(function applyFilters() {
        const q = query.trim().toLowerCase()
        const maxRank = minSeverity ? SEVERITY_RANK[minSeverity] : 99
        const matched = libraries.filter(function predicate(lib): boolean {
            if (q && !lib.packageName.toLowerCase().includes(q)) return false
            if (minSeverity) {
                const rank = topSeverityRank(lib.severities)
                if (rank > maxRank) return false
            }
            return true
        })
        return sortRows(matched, sort)
    }, [libraries, query, minSeverity, sort])

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-(--radius-card) border bg-card p-4">
                <Input
                    type="search"
                    placeholder={t('searchPackagesPlaceholder')}
                    value={query}
                    onChange={function onQueryChange(e) {
                        setQuery(e.target.value)
                    }}
                    className="h-9 w-56"
                    aria-label={t('searchPackagesAria')}
                />
                <Select
                    aria-label={t('filterBySeverity')}
                    value={minSeverity}
                    onChange={function onSevChange(e) {
                        setMinSeverity(e.target.value as MinSeverity)
                    }}
                >
                    {MIN_SEVERITY_OPTIONS.map(function opt(o) {
                        return (
                            <option key={o.value || 'any'} value={o.value}>
                                {t(o.labelKey)}
                            </option>
                        )
                    })}
                </Select>
                <Select
                    aria-label={t('filterByDepType')}
                    value={depType}
                    onChange={function onDepChange(e) {
                        onDepTypeChange(e.target.value as DepTypeFilter)
                    }}
                >
                    {DEP_TYPE_OPTIONS.map(function opt(o) {
                        return (
                            <option key={o.value} value={o.value}>
                                {t(o.labelKey)}
                            </option>
                        )
                    })}
                </Select>
                <Select
                    aria-label={t('sortBy')}
                    value={sort}
                    onChange={function onSortChange(e) {
                        setSort(e.target.value as SortKey)
                    }}
                >
                    {SORT_OPTIONS.map(function opt(o) {
                        return (
                            <option key={o.value} value={o.value}>
                                {t(o.labelKey)}
                            </option>
                        )
                    })}
                </Select>
            </div>
            {filtered.length === 0 ? (
                <EmptyState
                    title={t('librariesEmptyTitle')}
                    description={t('librariesEmptyDescription')}
                />
            ) : (
                <>
                    <div className="space-y-2 md:hidden">
                        {filtered.map(function card(lib) {
                            const maxSev = topSeverity(lib.severities)
                            const href = '/libraries/' + encodeURIComponent(lib.packageName)
                            function onCardClick(e: MouseEvent<HTMLDivElement>) {
                                const target = e.target as HTMLElement
                                if (target.closest('a, button, input, select, textarea, label')) return
                                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return
                                router.push(href)
                            }
                            return (
                                <Card key={lib.packageName} onClick={onCardClick} className="cursor-pointer p-4">
                                    <div className="flex items-center gap-2">
                                        {maxSev ? <SeverityPill variant={maxSev} size="sm" /> : null}
                                        <Link href={href} className="min-w-0 flex-1 truncate font-medium text-sm hover:opacity-80">
                                            {lib.packageName}
                                        </Link>
                                    </div>
                                    <dl className="mt-3 grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                                        <dt className="uppercase tracking-wide text-muted-foreground">{t('colAdvisories')}</dt>
                                        <dd className="font-mono">{lib.distinctAdvisories}</dd>
                                        <dt className="uppercase tracking-wide text-muted-foreground">{t('colAffectedProjects')}</dt>
                                        <dd className="font-mono">{lib.distinctProjects}</dd>
                                    </dl>
                                </Card>
                            )
                        })}
                    </div>
                    <div className="hidden md:block">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('colLibrary')}</TableHead>
                                    <TableHead>{t('colAdvisories')}</TableHead>
                                    <TableHead>{t('colAffectedProjects')}</TableHead>
                                    <TableHead>{t('colMaxSeverity')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map(function row(lib) {
                                    const maxSev = topSeverity(lib.severities)
                                    const href = '/libraries/' + encodeURIComponent(lib.packageName)
                                    function onRowClick(e: MouseEvent<HTMLTableRowElement>) {
                                        const target = e.target as HTMLElement
                                        if (target.closest('a, button, input, select, textarea, label')) return
                                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return
                                        router.push(href)
                                    }
                                    return (
                                        <TableRow key={lib.packageName} onClick={onRowClick} className="cursor-pointer">
                                            <TableCell className="font-medium">
                                                <Link href={href} className="hover:opacity-80">
                                                    {lib.packageName}
                                                </Link>
                                            </TableCell>
                                            <TableCell>{lib.distinctAdvisories}</TableCell>
                                            <TableCell>{lib.distinctProjects}</TableCell>
                                            <TableCell>
                                                {maxSev ? <SeverityPill variant={maxSev} size="sm" /> : '—'}
                                            </TableCell>
                                        </TableRow>
                                    )
                                })}
                            </TableBody>
                        </Table>
                    </div>
                </>
            )}
        </div>
    )
}

type LibraryFiltersState = {
    query: string
    minSeverity: MinSeverity
    sort: SortKey
}

const VALID_MIN_SEVERITY: MinSeverity[] = ['', 'critical', 'high', 'moderate', 'low']
const VALID_SORT: SortKey[] = ['severity', 'name', 'projects', 'advisories']

function parseLibraryFiltersFromSearch(search: string): Partial<LibraryFiltersState> {
    const params = new URLSearchParams(search)
    const out: Partial<LibraryFiltersState> = {}
    const q = params.get('lq')
    if (q) out.query = q
    const sev = params.get('lsev')
    if (sev && (VALID_MIN_SEVERITY as string[]).includes(sev)) out.minSeverity = sev as MinSeverity
    const s = params.get('lsort')
    if (s && (VALID_SORT as string[]).includes(s)) out.sort = s as SortKey
    return out
}

function mergeLibraryFiltersIntoParams(params: URLSearchParams, state: LibraryFiltersState): URLSearchParams {
    upsertParam(params, 'lq', state.query)
    upsertParam(params, 'lsev', state.minSeverity)
    upsertParam(params, 'lsort', state.sort !== 'severity' && state.sort)
    return params
}

function upsertParam(params: URLSearchParams, key: string, value: string | false | undefined): void {
    if (value) params.set(key, value)
    else params.delete(key)
}

function topSeverityRank(severities: string[]): number {
    let best = 99
    for (const sev of severities) {
        const rank = SEVERITY_RANK[sev]
        if (rank !== undefined && rank < best) best = rank
    }
    return best
}

function topSeverity(severities: string[]): Severity | null {
    let best: Severity | null = null
    let bestRank = 99
    for (const sev of severities) {
        const rank = SEVERITY_RANK[sev]
        if (rank === undefined || rank >= bestRank) continue
        if (sev === 'critical' || sev === 'high' || sev === 'moderate' || sev === 'low' || sev === 'info') {
            best = sev
            bestRank = rank
        }
    }
    return best
}

function sortRows(rows: LibrarySummary[], sort: SortKey): LibrarySummary[] {
    const copy = rows.slice()
    if (sort === 'name') {
        copy.sort(function byName(a, b) {
            return a.packageName.localeCompare(b.packageName)
        })
        return copy
    }
    if (sort === 'projects') {
        copy.sort(function byProjects(a, b) {
            return b.distinctProjects - a.distinctProjects || b.distinctAdvisories - a.distinctAdvisories || a.packageName.localeCompare(b.packageName)
        })
        return copy
    }
    if (sort === 'advisories') {
        copy.sort(function byAdvisories(a, b) {
            return b.distinctAdvisories - a.distinctAdvisories || b.distinctProjects - a.distinctProjects || a.packageName.localeCompare(b.packageName)
        })
        return copy
    }
    copy.sort(function bySeverity(a, b) {
        const sevDiff = topSeverityRank(a.severities) - topSeverityRank(b.severities)
        if (sevDiff !== 0) return sevDiff
        const projDiff = b.distinctProjects - a.distinctProjects
        if (projDiff !== 0) return projDiff
        const advDiff = b.distinctAdvisories - a.distinctAdvisories
        if (advDiff !== 0) return advDiff
        return a.packageName.localeCompare(b.packageName)
    })
    return copy
}
