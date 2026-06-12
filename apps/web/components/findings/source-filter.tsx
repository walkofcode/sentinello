'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Dropdown, type DropdownOption } from '@/components/ui/dropdown'
import { SOURCE_PARAM, parseSourceParam } from './source-order'

// Mirrors source-tags.tsx so the menu chips look identical to the row provenance tags.
function sourceVariant(scanner: string): BadgeProps['variant'] {
    if (scanner === 'osv') return 'osv'
    if (scanner === 'npm-audit') return 'npm'
    if (scanner === 'gemnasium') return 'gemnasium'
    return 'muted'
}
function sourceLabel(scanner: string): string {
    if (scanner === 'osv') return 'OSV'
    if (scanner === 'npm-audit') return 'npm'
    if (scanner === 'gemnasium') return 'gemnasium'
    return scanner
}

type Props = {
    // The enabled sources (npm-audit always on, OSV when configured), already in display order. This is
    // the filter universe — so "npm only" can filter to an empty table on a project where only OSV fired.
    sources: string[]
}

// URL-persisted multi-select over the enabled sources. Filtering by source is pure presentation over
// already-loaded rows (done in findings-section.tsx), so this only rewrites the ?src= param
// (router.replace, no scroll) and the section re-derives its filtered lists — no server round-trip,
// mirroring dep-type-filter.tsx. Renders nothing when fewer than two sources are enabled (an npm-only
// install never sees a redundant control). Uses the shared Dropdown so it matches every other dropdown.
export function SourceFilter({ sources }: Props) {
    const router = useRouter()
    const searchParams = useSearchParams()
    const t = useTranslations('Findings')
    if (sources.length < 2) return null
    const selected = parseSourceParam(searchParams.get(SOURCE_PARAM), sources)
    const options: DropdownOption[] = sources.map(function toOption(source) {
        return {
            value: source,
            label: sourceLabel(source),
            node: <Badge variant={sourceVariant(source)}>{sourceLabel(source)}</Badge>
        }
    })
    function onChange(next: string[]) {
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
        <Dropdown
            multiple
            ariaLabel={t('filterBySource')}
            allLabel={t('sourceAll')}
            values={selected}
            onChange={onChange}
            options={options}
        />
    )
}
