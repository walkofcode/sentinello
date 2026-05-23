'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { DepTypeFilter } from '@sentinello/core'

const OPTIONS: { value: DepTypeFilter; labelKey: string }[] = [
    { value: 'prod', labelKey: 'depTypeProd' },
    { value: 'dev', labelKey: 'depTypeDev' },
    { value: 'all', labelKey: 'depTypeAll' }
]

type Props = {
    value: DepTypeFilter
    defaultValue: DepTypeFilter
    paramName?: string
}

// Single-control client wrapper used by /projects/[id] and /libraries/[name] (otherwise pure
// server components). The select drives a router.replace so the Server Component re-renders with
// the new depType applied to its DB query — no client-side row filtering needed.
export function DepTypeFilter({ value, defaultValue, paramName = 'dep' }: Props) {
    const router = useRouter()
    const t = useTranslations('Findings')
    function onChange(next: DepTypeFilter) {
        const params = new URLSearchParams(window.location.search)
        if (next === defaultValue) params.delete(paramName)
        else params.set(paramName, next)
        const search = params.toString()
        const url = window.location.pathname + (search && '?' + search) + window.location.hash
        router.replace(url, { scroll: false })
    }
    return (
        <select
            aria-label={t('filterByDepType')}
            value={value}
            onChange={function onSelect(e) { onChange(e.target.value as DepTypeFilter) }}
            className="h-9 rounded-md border bg-card px-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
            {OPTIONS.map(function opt(o) {
                return (
                    <option key={o.value} value={o.value}>
                        {t(o.labelKey)}
                    </option>
                )
            })}
        </select>
    )
}
