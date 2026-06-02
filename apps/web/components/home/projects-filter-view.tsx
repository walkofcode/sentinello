'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ShieldCheck } from 'lucide-react'
import { reasonCodeLabel, type DepTypeFilter, type Locale, type ReasonCode, type Severity } from '@sentinello/core'
import type { ProjectCatalogRow } from '@sentinello/db'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { parseJsonArray, rootDisplayLabel } from '@/lib/format'
import { rememberProjectsUrl } from '@/lib/home-url-memory'
import { OverviewSection } from '@/components/home/overview-section'

type SortKey = 'name' | 'severity'

type MinSeverity = '' | Severity

const SEVERITY_RANK: Record<Severity, number> = {
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

const DEP_TYPE_OPTIONS: { value: DepTypeFilter; labelKey: string }[] = [
    { value: 'prod', labelKey: 'depProdOnly' },
    { value: 'dev', labelKey: 'depDevOnly' },
    { value: 'all', labelKey: 'depAll' }
]

type RootOption = { label: string; path: string }

type Props = {
    rows: ProjectCatalogRow[]
    depType: DepTypeFilter
    defaultDepType: DepTypeFilter
    librariesCount: number
    lastScanFinishedAt: number | null
    now: number
    anyInFlight: boolean
}

export function ProjectsFilterView({ rows, depType, defaultDepType, librariesCount, lastScanFinishedAt, now, anyInFlight }: Props) {
    const t = useTranslations('Home')
    const locale = useLocale() as Locale
    const router = useRouter()
    const [query, setQuery] = useState<string>('')
    const [root, setRoot] = useState<string>('')
    const [tag, setTag] = useState<string>('')
    const [minSeverity, setMinSeverity] = useState<MinSeverity>('')
    const [showHealthy, setShowHealthy] = useState<boolean>(false)
    const [showMuted, setShowMuted] = useState<boolean>(false)
    const [sort, setSort] = useState<SortKey>('severity')
    const hydratedRef = useRef<boolean>(false)

    // Hydrate filter state from the URL once on client mount. Defaults stay
    // until this runs (one-frame flash) to avoid SSR/CSR hydration mismatch.
    useEffect(function hydrateFromUrl() {
        const parsed = parseProjectFiltersFromSearch(window.location.search)
        if (parsed.query !== undefined) setQuery(parsed.query)
        if (parsed.root !== undefined) setRoot(parsed.root)
        if (parsed.tag !== undefined) setTag(parsed.tag)
        if (parsed.minSeverity !== undefined) setMinSeverity(parsed.minSeverity)
        if (parsed.showHealthy !== undefined) setShowHealthy(parsed.showHealthy)
        if (parsed.showMuted !== undefined) setShowMuted(parsed.showMuted)
        if (parsed.sort !== undefined) setSort(parsed.sort)
        hydratedRef.current = true
    }, [])

    // Write filter state back into the URL via replaceState (no router churn),
    // and remember it so the top-nav back button can land here later.
    useEffect(function syncUrl() {
        if (!hydratedRef.current) return
        const params = mergeProjectFiltersIntoParams(new URLSearchParams(window.location.search), {
            query, root, tag, minSeverity, showHealthy, showMuted, sort
        })
        const search = params.toString()
        const next = window.location.pathname + (search && '?' + search) + window.location.hash
        window.history.replaceState(window.history.state, '', next)
        rememberProjectsUrl(next)
    }, [query, root, tag, minSeverity, showHealthy, showMuted, sort])

    const rootOptions = useMemo(function buildRoots() {
        return uniqueRoots(rows)
    }, [rows])
    const tagOptions = useMemo(function buildTags() {
        return uniqueTags(rows)
    }, [rows])

    const filtered = useMemo(function applyFilters() {
        const q = query.trim().toLowerCase()
        const maxRank = minSeverity ? SEVERITY_RANK[minSeverity] : 99
        const matched = rows.filter(function predicate(row): boolean {
            if (root && row.rootPath !== root) return false
            if (tag) {
                const tags = parseJsonArray(row.tagsJson)
                if (!tags.includes(tag)) return false
            }
            if (row.muted) {
                if (!showMuted) return false
            } else if (!showHealthy && isHealthy(row)) {
                return false
            }
            if (q) {
                const haystack = (row.name + ' ' + (row.alias || '')).toLowerCase()
                if (!haystack.includes(q)) return false
            }
            if (minSeverity && topSeverityRank(row) > maxRank) return false
            return true
        })
        return sortRows(matched, sort)
    }, [rows, query, root, tag, minSeverity, showHealthy, showMuted, sort])

    // Overview cards summarize exactly the rows shown below, so the counts track every filter.
    const overviewCounts = useMemo(function buildOverview() {
        const severityCounts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 }
        let projectsWithFindings = 0
        for (const row of filtered) {
            const c = row.severityCounts
            severityCounts.critical += c.critical
            severityCounts.high += c.high
            severityCounts.moderate += c.moderate
            severityCounts.low += c.low
            severityCounts.info += c.info
            if (totalNonMutedFindings(row) > 0) projectsWithFindings++
        }
        return { projectsWithFindings, totalProjects: filtered.length, severityCounts }
    }, [filtered])

    function onDepTypeChange(next: DepTypeFilter) {
        const params = new URLSearchParams(window.location.search)
        if (next === defaultDepType) params.delete('pdep')
        else params.set('pdep', next)
        const search = params.toString()
        const url = window.location.pathname + (search && '?' + search) + window.location.hash
        router.replace(url, { scroll: false })
    }

    return (
        <div className="space-y-4">
            <ProjectFilters
                t={t}
                rootOptions={rootOptions}
                tagOptions={tagOptions}
                query={query}
                root={root}
                tag={tag}
                minSeverity={minSeverity}
                showHealthy={showHealthy}
                showMuted={showMuted}
                sort={sort}
                depType={depType}
                onQueryChange={setQuery}
                onRootChange={setRoot}
                onTagChange={setTag}
                onMinSeverityChange={setMinSeverity}
                onShowHealthyChange={setShowHealthy}
                onShowMutedChange={setShowMuted}
                onSortChange={setSort}
                onDepTypeChange={onDepTypeChange}
            />
            <OverviewSection
                counts={overviewCounts}
                librariesCount={librariesCount}
                lastScanFinishedAt={lastScanFinishedAt}
                now={now}
                anyInFlight={anyInFlight}
            />
            {filtered.length === 0 ? (
                rows.length === 0 ? (
                    <EmptyState
                        title={t('projectsNoneConfiguredTitle')}
                        description={t('projectsNoneConfiguredDescription')}
                    />
                ) : (
                    <div className="flex flex-col items-center justify-center rounded-(--radius-card) border border-dashed border-emerald-500/30 bg-emerald-500/5 px-6 py-16 text-center">
                        <ShieldCheck className="h-10 w-10 text-emerald-500" aria-hidden="true" />
                        <p className="mt-3 text-base font-medium">{t('projectsAllClearTitle')}</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t('projectsAllClearDescription')}
                        </p>
                    </div>
                )
            ) : (
                <>
                    <div className="space-y-2 md:hidden">
                        {filtered.map(function card(project) {
                            const scanReason = project.lastScanStatus && project.lastScanStatus !== 'ok'
                                ? reasonCodeLabel((project.lastScanReasonCode as ReasonCode | null) || null, locale)
                                : null
                            const href = '/projects/' + project.id
                            const tags = parseJsonArray(project.tagsJson)
                            function onCardClick(e: MouseEvent<HTMLDivElement>) {
                                const target = e.target as HTMLElement
                                if (target.closest('a, button, input, select, textarea, label')) return
                                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return
                                router.push(href)
                            }
                            return (
                                <Card key={project.id} onClick={onCardClick} className="cursor-pointer p-4">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <Link href={href} className="font-medium text-sm hover:opacity-80">
                                                {project.alias || project.name}
                                            </Link>
                                            <TagList tags={tags} />
                                        </div>
                                        <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                            {scanReason ? (
                                                <Badge variant="outline" title={project.lastScanErrorText || ''}>
                                                    {scanReason}
                                                </Badge>
                                            ) : null}
                                            {project.muted ? <Badge variant="muted">{t('badgeMuted')}</Badge> : null}
                                        </div>
                                    </div>
                                    <div className="mt-3">
                                        <SeverityCountsRow counts={project.severityCounts} />
                                    </div>
                                    <dl className="mt-3 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                                        <dt className="uppercase tracking-wide">{t('colRoot')}</dt>
                                        <dd className="min-w-0 break-words">{project.rootLabel || project.rootPath}</dd>
                                        <dt className="uppercase tracking-wide">{t('colPm')}</dt>
                                        <dd className="uppercase tracking-wide">{project.packageManager}</dd>
                                        <dt className="uppercase tracking-wide">{t('colNode')}</dt>
                                        <dd>{project.nvmrcVersion || t('nodeAmbient')}</dd>
                                    </dl>
                                </Card>
                            )
                        })}
                    </div>
                    <div className="hidden md:block">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('colName')}</TableHead>
                                    <TableHead>{t('colRoot')}</TableHead>
                                    <TableHead>{t('colPm')}</TableHead>
                                    <TableHead>{t('colNode')}</TableHead>
                                    <TableHead>{t('colSeverity')}</TableHead>
                                    <TableHead>{t('colState')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map(function row(project) {
                                    const scanReason = project.lastScanStatus && project.lastScanStatus !== 'ok'
                                        ? reasonCodeLabel((project.lastScanReasonCode as ReasonCode | null) || null, locale)
                                        : null
                                    const href = '/projects/' + project.id
                                    function onRowClick(e: MouseEvent<HTMLTableRowElement>) {
                                        const target = e.target as HTMLElement
                                        if (target.closest('a, button, input, select, textarea, label')) return
                                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return
                                        router.push(href)
                                    }
                                    return (
                                        <TableRow key={project.id} onClick={onRowClick} className="cursor-pointer">
                                            <TableCell className="font-medium">
                                                <Link href={href} className="hover:opacity-80">
                                                    {project.alias || project.name}
                                                </Link>
                                                <TagList tags={parseJsonArray(project.tagsJson)} />
                                            </TableCell>
                                            <TableCell className="text-xs text-muted-foreground">
                                                {project.rootLabel || project.rootPath}
                                            </TableCell>
                                            <TableCell className="text-xs uppercase tracking-wide text-muted-foreground">
                                                {project.packageManager}
                                            </TableCell>
                                            <TableCell className="text-xs text-muted-foreground">
                                                {project.nvmrcVersion || t('nodeAmbient')}
                                            </TableCell>
                                            <TableCell>
                                                <SeverityCountsRow counts={project.severityCounts} />
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex flex-wrap gap-1">
                                                    {scanReason ? (
                                                        <Badge variant="outline" title={project.lastScanErrorText || ''}>
                                                            {scanReason}
                                                        </Badge>
                                                    ) : null}
                                                    {project.muted ? <Badge variant="muted">muted</Badge> : null}
                                                </div>
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

function totalNonMutedFindings(row: ProjectCatalogRow): number {
    const c = row.severityCounts
    return c.critical + c.high + c.moderate + c.low + c.info
}

function isHealthy(row: ProjectCatalogRow): boolean {
    return row.lastScanStatus === 'ok' && totalNonMutedFindings(row) === 0
}

function topSeverityRank(row: ProjectCatalogRow): number {
    const c = row.severityCounts
    if (c.critical > 0) return SEVERITY_RANK.critical
    if (c.high > 0) return SEVERITY_RANK.high
    if (c.moderate > 0) return SEVERITY_RANK.moderate
    if (c.low > 0) return SEVERITY_RANK.low
    if (c.info > 0) return SEVERITY_RANK.info
    return 99
}

function sortRows(rows: ProjectCatalogRow[], sort: SortKey): ProjectCatalogRow[] {
    const copy = rows.slice()
    if (sort === 'severity') {
        copy.sort(function bySort(a, b) {
            return compareBySeverity(a, b) || displayName(a).localeCompare(displayName(b))
        })
        return copy
    }
    copy.sort(function byName(a, b) {
        return displayName(a).localeCompare(displayName(b))
    })
    return copy
}

function displayName(row: ProjectCatalogRow): string {
    return row.alias || row.name
}

function compareBySeverity(a: ProjectCatalogRow, b: ProjectCatalogRow): number {
    const ac = a.severityCounts
    const bc = b.severityCounts
    if (bc.critical !== ac.critical) return bc.critical - ac.critical
    if (bc.high !== ac.high) return bc.high - ac.high
    if (bc.moderate !== ac.moderate) return bc.moderate - ac.moderate
    if (bc.low !== ac.low) return bc.low - ac.low
    return bc.info - ac.info
}

type ProjectFiltersState = {
    query: string
    root: string
    tag: string
    minSeverity: MinSeverity
    showHealthy: boolean
    showMuted: boolean
    sort: SortKey
}

const VALID_MIN_SEVERITY: MinSeverity[] = ['', 'critical', 'high', 'moderate', 'low']
const VALID_SORT: SortKey[] = ['name', 'severity']

function parseProjectFiltersFromSearch(search: string): Partial<ProjectFiltersState> {
    const params = new URLSearchParams(search)
    const out: Partial<ProjectFiltersState> = {}
    const q = params.get('pq')
    if (q) out.query = q
    const r = params.get('proot')
    if (r) out.root = r
    const t = params.get('ptag')
    if (t) out.tag = t
    const sev = params.get('psev')
    if (sev && (VALID_MIN_SEVERITY as string[]).includes(sev)) out.minSeverity = sev as MinSeverity
    if (params.get('phealthy') === '1') out.showHealthy = true
    if (params.get('pmuted') === '1') out.showMuted = true
    const s = params.get('psort')
    if (s && (VALID_SORT as string[]).includes(s)) out.sort = s as SortKey
    return out
}

function mergeProjectFiltersIntoParams(params: URLSearchParams, state: ProjectFiltersState): URLSearchParams {
    upsertParam(params, 'pq', state.query)
    upsertParam(params, 'proot', state.root)
    upsertParam(params, 'ptag', state.tag)
    upsertParam(params, 'psev', state.minSeverity)
    upsertParam(params, 'phealthy', state.showHealthy && '1')
    upsertParam(params, 'pmuted', state.showMuted && '1')
    upsertParam(params, 'psort', state.sort !== 'severity' && state.sort)
    return params
}

function upsertParam(params: URLSearchParams, key: string, value: string | false | undefined): void {
    if (value) params.set(key, value)
    else params.delete(key)
}

function uniqueRoots(rows: ProjectCatalogRow[]): RootOption[] {
    const seen = new Map<string, string>()
    for (const row of rows) {
        if (!seen.has(row.rootPath)) seen.set(row.rootPath, rootDisplayLabel(row.rootLabel, row.rootPath))
    }
    return Array.from(seen.entries()).map(function entry([path, label]) {
        return { path, label }
    }).sort(function byLabel(a, b) {
        return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    })
}

function uniqueTags(rows: ProjectCatalogRow[]): string[] {
    const seen = new Set<string>()
    for (const row of rows) {
        for (const t of parseJsonArray(row.tagsJson)) seen.add(t)
    }
    return Array.from(seen.values()).sort()
}

type FiltersProps = {
    t: (key: string, values?: Record<string, string | number>) => string
    rootOptions: RootOption[]
    tagOptions: string[]
    query: string
    root: string
    tag: string
    minSeverity: MinSeverity
    showHealthy: boolean
    showMuted: boolean
    sort: SortKey
    depType: DepTypeFilter
    onQueryChange: (v: string) => void
    onRootChange: (v: string) => void
    onTagChange: (v: string) => void
    onMinSeverityChange: (v: MinSeverity) => void
    onShowHealthyChange: (v: boolean) => void
    onShowMutedChange: (v: boolean) => void
    onSortChange: (v: SortKey) => void
    onDepTypeChange: (v: DepTypeFilter) => void
}

function ProjectFilters(props: FiltersProps) {
    const t = props.t
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-(--radius-card) border bg-card p-4">
            <Input
                type="search"
                placeholder={t('searchProjectsPlaceholder')}
                value={props.query}
                onChange={function onQueryChange(e) {
                    props.onQueryChange(e.target.value)
                }}
                className="h-9 w-56"
                aria-label={t('searchProjectsAria')}
            />
            <FilterSelect
                ariaLabel={t('filterByRoot')}
                value={props.root}
                onChange={props.onRootChange}
                options={[{ value: '', label: t('allRoots') }, ...props.rootOptions.map(function toOpt(r) {
                    return { value: r.path, label: r.label }
                })]}
            />
            <FilterSelect
                ariaLabel={t('filterByTag')}
                value={props.tag}
                onChange={props.onTagChange}
                options={[{ value: '', label: t('allTags') }, ...props.tagOptions.map(function toOpt(tg) {
                    return { value: tg, label: tg }
                })]}
            />
            <FilterSelect
                ariaLabel={t('filterBySeverity')}
                value={props.minSeverity}
                onChange={function onMinSev(v) {
                    props.onMinSeverityChange(v as MinSeverity)
                }}
                options={MIN_SEVERITY_OPTIONS.map(function toOpt(o) {
                    return { value: o.value, label: t(o.labelKey) }
                })}
            />
            <FilterSelect
                ariaLabel={t('filterByDepType')}
                value={props.depType}
                onChange={function onDep(v) {
                    props.onDepTypeChange(v as DepTypeFilter)
                }}
                options={DEP_TYPE_OPTIONS.map(function toOpt(o) {
                    return { value: o.value, label: t(o.labelKey) }
                })}
            />
            <FilterSelect
                ariaLabel={t('sortBy')}
                value={props.sort}
                onChange={function onSort(v) {
                    props.onSortChange(v as SortKey)
                }}
                options={[
                    { value: 'severity', label: t('sortSeverity') },
                    { value: 'name', label: t('sortName') }
                ]}
            />
            <label className="flex items-center gap-2 text-sm">
                <input
                    type="checkbox"
                    checked={props.showHealthy}
                    onChange={function onChange(e) {
                        props.onShowHealthyChange(e.target.checked)
                    }}
                    className="h-4 w-4 rounded border"
                />
                {t('showHealthy')}
            </label>
            <label className="flex items-center gap-2 text-sm">
                <input
                    type="checkbox"
                    checked={props.showMuted}
                    onChange={function onChange(e) {
                        props.onShowMutedChange(e.target.checked)
                    }}
                    className="h-4 w-4 rounded border"
                />
                {t('showMuted')}
            </label>
        </div>
    )
}

type FilterSelectProps = {
    ariaLabel: string
    value: string
    options: { value: string; label: string }[]
    onChange: (value: string) => void
}

function FilterSelect(props: FilterSelectProps) {
    return (
        <Select
            aria-label={props.ariaLabel}
            value={props.value}
            onChange={function onChange(e) {
                props.onChange(e.target.value)
            }}
        >
            {props.options.map(function opt(o) {
                return (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                )
            })}
        </Select>
    )
}

function TagList({ tags }: { tags: string[] }) {
    if (tags.length === 0) return null
    return (
        <div className="mt-1 flex flex-wrap gap-1">
            {tags.map(function chip(t) {
                return (
                    <Badge key={t} variant="outline" className="normal-case tracking-normal">
                        {t}
                    </Badge>
                )
            })}
        </div>
    )
}

function SeverityCountsRow({ counts }: { counts: ProjectCatalogRow['severityCounts'] }) {
    const total = counts.critical + counts.high + counts.moderate + counts.low + counts.info
    if (total === 0) {
        return <span className="text-xs text-muted-foreground">—</span>
    }
    return (
        <div className="flex flex-wrap gap-1">
            <SeverityPill variant="critical" count={counts.critical} size="sm" />
            <SeverityPill variant="high" count={counts.high} size="sm" />
            <SeverityPill variant="moderate" count={counts.moderate} size="sm" />
            <SeverityPill variant="low" count={counts.low} size="sm" />
            <SeverityPill variant="info" count={counts.info} size="sm" />
        </div>
    )
}
