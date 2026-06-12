'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Dropdown, type DropdownOption } from '@/components/ui/dropdown'
import { EcosystemBadge } from './ecosystem-badge'
import { ECOSYSTEM_PARAM, parseEcosystemParam } from './source-order'

type Props = {
    // The ecosystems present in the loaded findings, already in display order. This is the filter
    // universe so selecting one language can resolve to an empty table on a project where it didn't fire.
    ecosystems: string[]
}

// URL-persisted multi-select over the project's ecosystems. Like SourceFilter, filtering is pure
// presentation over already-loaded rows, so this only rewrites the ?eco= param and the findings section
// re-derives its lists. Renders nothing when fewer than two ecosystems are present (an npm-only project
// never sees a redundant control).
export function EcosystemFilter({ ecosystems }: Props) {
    const router = useRouter()
    const searchParams = useSearchParams()
    const t = useTranslations('Findings')
    if (ecosystems.length < 2) return null
    const selected = parseEcosystemParam(searchParams.get(ECOSYSTEM_PARAM), ecosystems)
    const options: DropdownOption[] = ecosystems.map(function toOption(ecosystem) {
        return {
            value: ecosystem,
            label: ecosystem,
            node: <EcosystemBadge ecosystem={ecosystem} />
        }
    })
    function onChange(next: string[]) {
        const params = new URLSearchParams(window.location.search)
        if (next.length === 0 || next.length === ecosystems.length) params.delete(ECOSYSTEM_PARAM)
        else params.set(ECOSYSTEM_PARAM, next.join(','))
        const search = params.toString()
        const url = window.location.pathname + (search && '?' + search) + window.location.hash
        router.replace(url, { scroll: false })
    }
    return (
        <Dropdown
            multiple
            ariaLabel={t('filterByEcosystem')}
            allLabel={t('ecosystemAll')}
            values={selected}
            onChange={onChange}
            options={options}
        />
    )
}
