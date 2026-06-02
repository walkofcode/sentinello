'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { cn } from '@/lib/cn'

export const SOURCE_PARAM = 'src'

// npm audit before OSV before anything else, matching the row source-tag order so the filter chips
// read consistently with the table.
const SOURCE_ORDER: Record<string, number> = { 'npm-audit': 0, osv: 1 }

// Distinct sources present in a set of scanner names, in display order. Drives which chips render.
export function orderSources(scanners: Iterable<string>): string[] {
    return [...new Set(scanners)].sort(function order(a, b) {
        return (SOURCE_ORDER[a] ?? 9) - (SOURCE_ORDER[b] ?? 9) || a.localeCompare(b)
    })
}

// Parse the ?src= param into the selected source set, intersected with what's actually present so a
// stale / unknown / now-disabled source in the URL is silently ignored. Empty result = "all".
export function parseSourceParam(raw: string | null | undefined, present: string[]): string[] {
    if (!raw) return []
    const wanted = raw.split(',').map(function trim(s) { return s.trim() }).filter(Boolean)
    return present.filter(function isWanted(s) { return wanted.includes(s) })
}

// Mirrors source-tags.tsx so the filter chips look identical to the row provenance tags.
function sourceVariant(scanner: string): BadgeProps['variant'] {
    if (scanner === 'osv') return 'osv'
    if (scanner === 'npm-audit') return 'npm'
    return 'muted'
}
function sourceLabel(scanner: string): string {
    if (scanner === 'osv') return 'OSV'
    if (scanner === 'npm-audit') return 'npm'
    return scanner
}

type Props = {
    // Distinct scanners present in the loaded rows, in display order (use orderSources).
    sources: string[]
    // Currently-selected sources (empty = all). Already intersected with `sources` by the caller.
    selected: string[]
}

// URL-persisted multi-select over the sources present in the current view. Filtering by source is
// pure presentation over already-loaded rows, so this only rewrites the ?src= param (router.replace,
// no scroll) and the parent re-derives the filtered lists — no server round-trip, mirroring
// dep-type-filter.tsx. Renders nothing when fewer than two sources are present (npm-only installs
// never see a redundant control).
export function SourceFilter({ sources, selected }: Props) {
    const router = useRouter()
    const t = useTranslations('Findings')
    if (sources.length < 2) return null
    // Empty selection means "all" — render every chip active so the unfiltered state reads clearly.
    const activeSet = selected.length === 0 ? sources : selected
    function toggle(source: string) {
        const current = selected.length === 0 ? [...sources] : [...selected]
        const next = current.includes(source)
            ? current.filter(function notIt(s) { return s !== source })
            : [...current, source]
        const params = new URLSearchParams(window.location.search)
        // All-selected and none-selected both collapse to the unfiltered default (param removed), so a
        // deselect-the-last click resets to "all" instead of rendering an empty table.
        if (next.length === 0 || next.length === sources.length) params.delete(SOURCE_PARAM)
        else params.set(SOURCE_PARAM, next.join(','))
        const search = params.toString()
        const url = window.location.pathname + (search && '?' + search) + window.location.hash
        router.replace(url, { scroll: false })
    }
    return (
        <div className="flex items-center gap-1.5" role="group" aria-label={t('filterBySource')}>
            {sources.map(function chip(source) {
                const isActive = activeSet.includes(source)
                return (
                    <button
                        key={source}
                        type="button"
                        onClick={function onClick() { toggle(source) }}
                        aria-pressed={isActive}
                        className={cn(
                            'rounded-md transition-opacity focus:outline-none focus:ring-2 focus:ring-primary',
                            isActive ? 'opacity-100' : 'opacity-40 hover:opacity-70'
                        )}
                    >
                        <Badge variant={sourceVariant(source)}>{sourceLabel(source)}</Badge>
                    </button>
                )
            })}
        </div>
    )
}
