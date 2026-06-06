'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { DepTypeFilter } from '@sentinello/core'
import { Dropdown, type DropdownOption } from '@/components/ui/dropdown'

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
// server components). The dropdown drives a router.replace so the Server Component re-renders with
// the new depType applied to its DB query — no client-side row filtering needed.
export function DepTypeFilter({ value, defaultValue, paramName = 'dep' }: Props) {
    const router = useRouter()
    const t = useTranslations('Findings')
    function onChange(next: string) {
        const params = new URLSearchParams(window.location.search)
        if (next === defaultValue) params.delete(paramName)
        else params.set(paramName, next)
        const search = params.toString()
        const url = window.location.pathname + (search && '?' + search) + window.location.hash
        router.replace(url, { scroll: false })
    }
    const options: DropdownOption[] = OPTIONS.map(function toOption(o) {
        return { value: o.value, label: t(o.labelKey) }
    })
    return (
        <Dropdown
            ariaLabel={t('filterByDepType')}
            value={value}
            onChange={onChange}
            options={options}
        />
    )
}
