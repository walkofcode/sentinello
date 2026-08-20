'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useTranslations } from 'next-intl'
import type { LibrarySummary } from '@sentinello/db'
import { maxSeverity, severityWeight, type DepTypeFilter, type Severity } from '@sentinello/core'
import { Card } from '@/components/ui/card'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Dropdown } from '@/components/ui/dropdown'
import { EcosystemBadge } from '@/components/findings/ecosystem-badge'
import { libraryHref } from '@/lib/library-href'
import { rememberLibrariesUrl } from '@/lib/home-url-memory'

type SortKey = 'severity' | 'name' | 'projects' | 'advisories'

type MinSeverity = '' | Severity

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
    //
    // `depType` is a prop written by router.replace rather than state, but it belongs in the serialized
    // state and in these dependencies — without it, changing the dep type never refreshed the
    // remembered URL and the back link dropped ?ldep. Same defect the projects view had with ?pdep.
    //
    // `libraries` is a render signal: router.refresh() restores the URL the Next router knows, which
    // omits everything written by history.replaceState, so the app-wide auto-refresh would otherwise
    // strip the l* params from the address bar on every tick.
    useEffect(function syncUrl() {
        if (!hydratedRef.current) return
        const params = mergeLibraryFiltersIntoParams(new URLSearchParams(window.location.search), {
            query, minSeverity, sort, depType
        }, defaultDepType)
        const search = params.toString()
        const next = window.location.pathname + (search && '?' + search) + window.location.hash
        window.history.replaceState(window.history.state, '', next)
        rememberLibrariesUrl(next)
    }, [query, minSeverity, sort, depType, defaultDepType, libraries])

    const filtered = useMemo(function applyFilters() {
        const q = query.trim().toLowerCase()
        const floor = minSeverity ? severityWeight(minSeverity) : 0
        const matched = libraries.filter(function predicate(lib): boolean {
            if (q && !lib.packageName.toLowerCase().includes(q)) return false
            if (minSeverity) {
                if (topSeverityWeight(lib.severities) < floor) return false
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
                <Dropdown
                    ariaLabel={t('filterBySeverity')}
                    value={minSeverity}
                    onChange={function onSevChange(v) { setMinSeverity(v as MinSeverity) }}
                    options={MIN_SEVERITY_OPTIONS.map(function opt(o) {
                        return { value: o.value, label: t(o.labelKey) }
                    })}
                />
                <Dropdown
                    ariaLabel={t('filterByDepType')}
                    value={depType}
                    onChange={function onDepChange(v) { onDepTypeChange(v as DepTypeFilter) }}
                    options={DEP_TYPE_OPTIONS.map(function opt(o) {
                        return { value: o.value, label: t(o.labelKey) }
                    })}
                />
                <Dropdown
                    ariaLabel={t('sortBy')}
                    value={sort}
                    onChange={function onSortChange(v) { setSort(v as SortKey) }}
                    options={SORT_OPTIONS.map(function opt(o) {
                        return { value: o.value, label: t(o.labelKey) }
                    })}
                />
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
                            const href = libraryHref(lib.ecosystem, lib.packageName)
                            function onCardClick(e: MouseEvent<HTMLDivElement>) {
                                const target = e.target as HTMLElement
                                if (target.closest('a, button, input, select, textarea, label')) return
                                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return
                                router.push(href)
                            }
                            return (
                                <Card key={lib.ecosystem + ':' + lib.packageName} onClick={onCardClick} className="cursor-pointer p-4">
                                    <div className="flex items-center gap-2">
                                        {maxSev ? <SeverityPill variant={maxSev} size="sm" /> : null}
                                        <Link href={href} className="min-w-0 flex-1 truncate font-medium text-sm hover:opacity-80">
                                            {lib.packageName}
                                        </Link>
                                        <EcosystemBadge ecosystem={lib.ecosystem} />
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
                                    <TableHead>{t('colLanguage')}</TableHead>
                                    <TableHead>{t('colAdvisories')}</TableHead>
                                    <TableHead>{t('colAffectedProjects')}</TableHead>
                                    <TableHead>{t('colMaxSeverity')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map(function row(lib) {
                                    const maxSev = topSeverity(lib.severities)
                                    const href = libraryHref(lib.ecosystem, lib.packageName)
                                    function onRowClick(e: MouseEvent<HTMLTableRowElement>) {
                                        const target = e.target as HTMLElement
                                        if (target.closest('a, button, input, select, textarea, label')) return
                                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return
                                        router.push(href)
                                    }
                                    return (
                                        <TableRow key={lib.ecosystem + ':' + lib.packageName} onClick={onRowClick} className="cursor-pointer">
                                            <TableCell className="font-medium">
                                                <Link href={href} className="hover:opacity-80">
                                                    {lib.packageName}
                                                </Link>
                                            </TableCell>
                                            <TableCell><EcosystemBadge ecosystem={lib.ecosystem} /></TableCell>
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
    depType: DepTypeFilter
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

function mergeLibraryFiltersIntoParams(
    params: URLSearchParams,
    state: LibraryFiltersState,
    defaultDepType: DepTypeFilter
): URLSearchParams {
    upsertParam(params, 'lq', state.query)
    upsertParam(params, 'lsev', state.minSeverity)
    upsertParam(params, 'lsort', state.sort !== 'severity' && state.sort)
    upsertParam(params, 'ldep', state.depType !== defaultDepType && state.depType)
    return params
}

function upsertParam(params: URLSearchParams, key: string, value: string | false | undefined): void {
    if (value) params.set(key, value)
    else params.delete(key)
}

// Weight of the most severe entry; 0 when the list is empty, which sorts below every real severity.
// Higher = worse, matching severityWeight in @sentinello/core.
function topSeverityWeight(severities: string[]): number {
    let best = 0
    for (const sev of severities) {
        const weight = severityWeight(sev)
        if (weight > best) best = weight
    }
    return best
}

// The badge shown for a library. maxSeverity only ever returns one of the five declared severities, so
// an unrecognized value can never reach the badge — but it returns 'info' for an empty list, which here
// must stay null so a library with no severities renders no badge at all.
function topSeverity(severities: string[]): Severity | null {
    if (severities.length === 0) return null
    return maxSeverity(severities)
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
        const sevDiff = topSeverityWeight(b.severities) - topSeverityWeight(a.severities)
        if (sevDiff !== 0) return sevDiff
        const projDiff = b.distinctProjects - a.distinctProjects
        if (projDiff !== 0) return projDiff
        const advDiff = b.distinctAdvisories - a.distinctAdvisories
        if (advDiff !== 0) return advDiff
        return a.packageName.localeCompare(b.packageName)
    })
    return copy
}
