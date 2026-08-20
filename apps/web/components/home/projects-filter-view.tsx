'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ShieldCheck } from 'lucide-react'
import { severityWeight, type DepTypeFilter, type Locale } from '@sentinello/core'
import type { ProjectCatalogRow } from '@sentinello/db'
import { Badge } from '@/components/ui/badge'
import { ExportAdvisoryButton } from '@/components/triage/export-advisory-button'
import { MuteDialog } from '@/components/triage/mute-dialog'
import { ScanNowButton } from '@/components/triage/scan-now-button'
import { TagEditor } from '@/components/triage/tag-editor'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dropdown } from '@/components/ui/dropdown'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { parseJsonArray, rootDisplayLabel } from '@/lib/format'
import { rememberProjectsUrl } from '@/lib/home-url-memory'
import { isProjectHealthy, problemScanStates, scanStateLabel } from '@/lib/project-state'
import {
    buildProjectFiltersUrl,
    parseProjectFiltersFromSearch,
    type MinSeverity,
    type ProjectFiltersState,
    type SortKey
} from '@/lib/project-filters'
import { OverviewSection } from '@/components/home/overview-section'

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

type RootOption = { label: string; id: string }

type Props = {
    rows: ProjectCatalogRow[]
    // Ids of projects covered by an in-flight scan (direct, by root, or a full sweep), resolved in
    // one query by the page rather than per row.
    inFlightProjectIds: string[]
    depType: DepTypeFilter
    defaultDepType: DepTypeFilter
    librariesCount: number
    lastScanFinishedAt: number | null
    now: number
    anyInFlight: boolean
}

export function ProjectsFilterView({ rows, inFlightProjectIds, depType, defaultDepType, librariesCount, lastScanFinishedAt, now, anyInFlight }: Props) {
    const t = useTranslations('Home')
    const router = useRouter()
    const [query, setQuery] = useState<string>('')
    const [roots, setRoots] = useState<string[]>([])
    const [tags, setTags] = useState<string[]>([])
    const [minSeverity, setMinSeverity] = useState<MinSeverity>('')
    const [showHealthy, setShowHealthy] = useState<boolean>(false)
    const [showMuted, setShowMuted] = useState<boolean>(false)
    const [sort, setSort] = useState<SortKey>('severity')
    const hydratedRef = useRef<boolean>(false)

    // One object so the URL writer has a single dependency and cannot be updated for six filters and
    // silently miss the seventh.
    const filterState: ProjectFiltersState = useMemo(function buildState() {
        return { query, roots, tags, minSeverity, showHealthy, showMuted, sort, depType }
    }, [query, roots, tags, minSeverity, showHealthy, showMuted, sort, depType])

    // Hydrate filter state from the URL once on client mount. Defaults stay
    // until this runs (one-frame flash) to avoid SSR/CSR hydration mismatch. The guard, not the
    // dependency list, is what makes it run once — the universe it needs to intersect stale root and
    // tag ids against is derived from `rows`, so the effect has to declare that dependency honestly.
    useEffect(function hydrateFromUrl() {
        if (hydratedRef.current) return
        const parsed = parseProjectFiltersFromSearch(window.location.search, {
            roots: uniqueRoots(rows).map(function toId(r) { return r.id }),
            tags: uniqueTags(rows)
        })
        if (parsed.query !== undefined) setQuery(parsed.query)
        if (parsed.roots !== undefined) setRoots(parsed.roots)
        if (parsed.tags !== undefined) setTags(parsed.tags)
        if (parsed.minSeverity !== undefined) setMinSeverity(parsed.minSeverity)
        if (parsed.showHealthy !== undefined) setShowHealthy(parsed.showHealthy)
        if (parsed.showMuted !== undefined) setShowMuted(parsed.showMuted)
        if (parsed.sort !== undefined) setSort(parsed.sort)
        hydratedRef.current = true
    }, [rows])

    // Write filter state back into the URL via replaceState (no router churn), and remember it so the
    // top-nav back button can land here later.
    //
    // `depType` is a prop rather than state — it round-trips through the server, since it changes the
    // SQL — but it MUST stay in this effect's dependencies. It was the one param written elsewhere
    // (onDepTypeChange's router.replace), which meant changing it never refreshed the remembered URL:
    // the back link from a project silently dropped ?pdep and reverted to the default dep type.
    useEffect(function syncUrl() {
        if (!hydratedRef.current) return
        const next = buildProjectFiltersUrl(window.location, filterState, defaultDepType)
        window.history.replaceState(window.history.state, '', next)
        rememberProjectsUrl(next)
        // `rows` is in here as a render signal, not because the URL depends on it: router.refresh()
        // restores the URL the Next router knows, which does not include anything written by
        // history.replaceState — so every auto-refresh silently dropped the client-side filter params
        // from the address bar (the filters themselves survive; the shareable URL did not). A fresh
        // `rows` identity is exactly "the server just re-rendered", which is when to re-assert.
    }, [filterState, defaultDepType, rows])

    const inFlightSet = useMemo(function buildInFlight() {
        return new Set(inFlightProjectIds)
    }, [inFlightProjectIds])

    const rootOptions = useMemo(function buildRoots() {
        return uniqueRoots(rows)
    }, [rows])
    const tagOptions = useMemo(function buildTags() {
        return uniqueTags(rows)
    }, [rows])

    const filtered = useMemo(function applyFilters() {
        const q = query.trim().toLowerCase()
        const floor = minSeverity ? severityWeight(minSeverity) : 0
        const matched = rows.filter(function predicate(row): boolean {
            if (roots.length > 0 && !roots.includes(row.rootId)) return false
            if (tags.length > 0) {
                // OR within the control: a project matches if it carries ANY selected tag, mirroring
                // how multiple roots must behave. AND-ing them would make the two adjacent multi-selects
                // mean different things.
                const rowTags = parseJsonArray(row.tagsJson)
                if (!rowTags.some(function anyMatch(rt) { return tags.includes(rt) })) return false
            }
            if (row.muted) {
                if (!showMuted) return false
            } else if (!showHealthy && isProjectHealthy(row, totalNonMutedFindings(row))) {
                return false
            }
            if (q) {
                const haystack = (row.name + ' ' + (row.alias || '')).toLowerCase()
                if (!haystack.includes(q)) return false
            }
            if (minSeverity && topSeverityWeight(row) < floor) return false
            return true
        })
        return sortRows(matched, sort)
    }, [rows, query, roots, tags, minSeverity, showHealthy, showMuted, sort])

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

    // The only filter that has to reach the server: pdep changes the SQL, so the row set and every
    // severity count are recomputed rather than re-filtered on the client.
    function onDepTypeChange(next: DepTypeFilter) {
        const url = buildProjectFiltersUrl(window.location, { ...filterState, depType: next }, defaultDepType)
        router.replace(url, { scroll: false })
    }

    return (
        <div className="space-y-4">
            <ProjectFilters
                t={t}
                rootOptions={rootOptions}
                tagOptions={tagOptions}
                query={query}
                roots={roots}
                tags={tags}
                minSeverity={minSeverity}
                showHealthy={showHealthy}
                showMuted={showMuted}
                sort={sort}
                depType={depType}
                onQueryChange={setQuery}
                onRootsChange={setRoots}
                onTagsChange={setTags}
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
                                            <ScanStateBadges row={project} />
                                            {project.muted ? <Badge variant="muted">{t('badgeMuted')}</Badge> : null}
                                        </div>
                                    </div>
                                    <div className="mt-3">
                                        <SeverityCountsRow counts={project.severityCounts} />
                                    </div>
                                    <dl className="mt-3 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                                        <dt className="uppercase tracking-wide">{t('colBranch')}</dt>
                                        <dd className="min-w-0 break-words">{project.gitBranch || '—'}</dd>
                                        <dt className="uppercase tracking-wide">{t('colRoot')}</dt>
                                        <dd className="min-w-0 break-words">{project.rootLabel || project.rootPath}</dd>
                                        <dt className="uppercase tracking-wide">{t('colPm')}</dt>
                                        <dd className="uppercase tracking-wide">{project.packageManager}</dd>
                                        <dt className="uppercase tracking-wide">{t('colNode')}</dt>
                                        <dd>{project.nvmrcVersion || t('nodeAmbient')}</dd>
                                    </dl>
                                    <div className="mt-3 flex justify-end">
                                        <RowActions project={project} depType={depType} scanning={inFlightSet.has(project.id)} />
                                    </div>
                                </Card>
                            )
                        })}
                    </div>
                    <div className="hidden md:block">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('colName')}</TableHead>
                                    <TableHead>{t('colBranch')}</TableHead>
                                    <TableHead>{t('colRoot')}</TableHead>
                                    <TableHead>{t('colPm')}</TableHead>
                                    <TableHead>{t('colNode')}</TableHead>
                                    <TableHead>{t('colSeverity')}</TableHead>
                                    <TableHead>{t('colState')}</TableHead>
                                    <TableHead className="w-px whitespace-nowrap text-right">{t('colActions')}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map(function row(project) {
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
                                                <span className="block max-w-40 truncate" title={project.gitBranch || ''}>
                                                    {project.gitBranch || '—'}
                                                </span>
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
                                                    <ScanStateBadges row={project} />
                                                    {project.muted ? <Badge variant="muted">{t('badgeMuted')}</Badge> : null}
                                                </div>
                                            </TableCell>
                                            <TableCell className="w-px whitespace-nowrap text-right align-middle">
                                                <RowActions project={project} depType={depType} scanning={inFlightSet.has(project.id)} />
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

// Weight of the project's worst finding; 0 when it has none, which sorts below every real severity.
// Higher = worse, matching severityWeight in @sentinello/core.
function topSeverityWeight(row: ProjectCatalogRow): number {
    const c = row.severityCounts
    if (c.critical > 0) return severityWeight('critical')
    if (c.high > 0) return severityWeight('high')
    if (c.moderate > 0) return severityWeight('moderate')
    if (c.low > 0) return severityWeight('low')
    if (c.info > 0) return severityWeight('info')
    return 0
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

function uniqueRoots(rows: ProjectCatalogRow[]): RootOption[] {
    const seen = new Map<string, string>()
    for (const row of rows) {
        if (!seen.has(row.rootId)) seen.set(row.rootId, rootDisplayLabel(row.rootLabel, row.rootPath))
    }
    return Array.from(seen.entries()).map(function entry([id, label]) {
        return { id, label }
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
    roots: string[]
    tags: string[]
    minSeverity: MinSeverity
    showHealthy: boolean
    showMuted: boolean
    sort: SortKey
    depType: DepTypeFilter
    onQueryChange: (v: string) => void
    onRootsChange: (v: string[]) => void
    onTagsChange: (v: string[]) => void
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
            {/* Both multi-selects hide when they cannot do anything: no tags anywhere, or a
                single-root install where "filter by root" only ever offers the root you are already
                looking at. The `.length > 0` half of each guard keeps an ACTIVE selection visible —
                a stale ?proot / ?ptag from a bookmark must stay clearable rather than filtering the
                table to nothing behind a control that is no longer rendered. Mirrors SourceFilter. */}
            {props.rootOptions.length > 1 || props.roots.length > 0 ? (
                <Dropdown
                    multiple
                    additive
                    ariaLabel={t('filterByRoot')}
                    allLabel={t('allRoots')}
                    values={props.roots}
                    onChange={props.onRootsChange}
                    options={props.rootOptions.map(function toOpt(r) {
                        return { value: r.id, label: r.label }
                    })}
                />
            ) : null}
            {props.tagOptions.length > 0 || props.tags.length > 0 ? (
                <Dropdown
                    multiple
                    additive
                    ariaLabel={t('filterByTag')}
                    allLabel={t('allTags')}
                    values={props.tags}
                    onChange={props.onTagsChange}
                    options={props.tagOptions.map(function toOpt(tg) {
                        return { value: tg, label: tg }
                    })}
                />
            ) : null}
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
        <Dropdown
            ariaLabel={props.ariaLabel}
            value={props.value}
            onChange={props.onChange}
            options={props.options}
        />
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

// The same four actions the project detail page offers, in their icon-only form, so a triage pass
// over the list never needs a round-trip into each project. These are the SAME components the
// detail page renders, not copies — behaviour cannot drift between the two surfaces.
// The row/card click handlers ignore clicks landing on a button, so these never navigate.
function RowActions({ project, depType, scanning }: { project: ProjectCatalogRow; depType: DepTypeFilter; scanning: boolean }) {
    const tTriage = useTranslations('Triage')
    return (
        <div className="flex items-center justify-end gap-1">
            <ScanNowButton projectId={project.id} scanning={scanning} iconOnly />
            <ExportAdvisoryButton scope="project" projectId={project.id} depType={depType} iconOnly />
            {project.muteId ? (
                <MuteDialog
                    projectId={project.id}
                    muteId={project.muteId}
                    label={tTriage('mute.unmuteProject')}
                    iconOnly
                    iconSize="md"
                />
            ) : (
                <MuteDialog projectId={project.id} targetLabel={project.alias || project.name} iconOnly iconSize="md" />
            )}
            <TagEditor projectId={project.id} initialTags={parseJsonArray(project.tagsJson)} iconOnly />
        </div>
    )
}

// One badge per source that could not answer. A source that returned ok shows nothing, so a healthy
// project's State cell is empty and a project where npm audit worked but OSV was never seeded shows
// exactly one badge — naming OSV, rather than condemning the whole project.
function ScanStateBadges({ row }: { row: ProjectCatalogRow }) {
    const locale = useLocale() as Locale
    return (
        <>
            {problemScanStates(row).map(function stateBadge(state) {
                return (
                    <Badge key={state.source} variant="outline" title={state.errorText || ''}>
                        {scanStateLabel(state, locale)}
                    </Badge>
                )
            })}
        </>
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
