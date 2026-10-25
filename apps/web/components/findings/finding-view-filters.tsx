'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Dropdown } from '@/components/ui/dropdown'
import { DEFAULT_SORT, MIN_SEVERITY_PARAM, SORT_PARAM, parseMinSeverityParam, parseSortParam } from '@/lib/finding-view'

const MIN_SEVERITY_OPTIONS: { value: string; labelKey: string }[] = [
    { value: '', labelKey: 'severityAny' },
    { value: 'critical', labelKey: 'severityCriticalOnly' },
    { value: 'high', labelKey: 'severityHighPlus' },
    { value: 'moderate', labelKey: 'severityModeratePlus' },
    { value: 'low', labelKey: 'severityLowPlus' }
]

// The detail pages' severity floor and sort: the dashboard's two controls, with the dashboard's labels
// (the Home catalog), so a project opened from the dashboard shows the same choices it was filtered by.
// Like SourceFilter, filtering is pure presentation over loaded rows, so each only rewrites its param.
export function SeverityFloorFilter() {
    const t = useTranslations('Home')
    const searchParams = useSearchParams()
    const router = useRouter()
    function onChange(next: string) {
        replaceParam(router, MIN_SEVERITY_PARAM, next, '')
    }
    return (
        <Dropdown
            ariaLabel={t('filterBySeverity')}
            value={parseMinSeverityParam(searchParams.get(MIN_SEVERITY_PARAM))}
            onChange={onChange}
            options={MIN_SEVERITY_OPTIONS.map(function toOption(o) {
                return { value: o.value, label: t(o.labelKey) }
            })}
        />
    )
}

export function FindingSortFilter() {
    const t = useTranslations('Home')
    const searchParams = useSearchParams()
    const router = useRouter()
    function onChange(next: string) {
        replaceParam(router, SORT_PARAM, next, DEFAULT_SORT)
    }
    return (
        <Dropdown
            ariaLabel={t('sortBy')}
            value={parseSortParam(searchParams.get(SORT_PARAM))}
            onChange={onChange}
            options={[
                { value: 'severity', label: t('sortSeverity') },
                { value: 'name', label: t('sortName') }
            ]}
        />
    )
}

function replaceParam(router: ReturnType<typeof useRouter>, name: string, next: string, defaultValue: string): void {
    const params = new URLSearchParams(window.location.search)
    if (next === defaultValue) params.delete(name)
    else params.set(name, next)
    const search = params.toString()
    const url = window.location.pathname + (search && '?' + search) + window.location.hash
    router.replace(url, { scroll: false })
}
