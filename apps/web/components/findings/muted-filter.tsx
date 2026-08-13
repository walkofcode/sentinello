'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

export const MUTED_PARAM = 'muted'

type Props = {
    value: boolean
    // How many rows are currently being withheld. Zero means the project has no mutes at all, so the
    // control renders nothing rather than offering a toggle that cannot change anything.
    mutedCount: number
    paramName?: string
}

// Muted findings are an accepted-risk decision, so by default they are out of the picture entirely —
// out of the table AND out of every count derived from it. Ticking this puts them back in both, exactly
// the way the dep-type filter widens the universe rather than merely restyling rows. The toggle drives a
// URL param and a router.replace so the Server Component re-runs and recomputes the counts, mirroring
// dep-type-filter.tsx.
export function MutedFilter({ value, mutedCount, paramName = MUTED_PARAM }: Props) {
    const router = useRouter()
    const t = useTranslations('Findings')
    if (mutedCount === 0) return null
    function onChange(e: React.ChangeEvent<HTMLInputElement>) {
        const params = new URLSearchParams(window.location.search)
        if (e.target.checked) params.set(paramName, '1')
        else params.delete(paramName)
        const search = params.toString()
        const url = window.location.pathname + (search && '?' + search) + window.location.hash
        router.replace(url, { scroll: false })
    }
    return (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
                type="checkbox"
                checked={value}
                onChange={onChange}
                className="h-3.5 w-3.5 cursor-pointer accent-primary"
            />
            {t('showMuted', { count: mutedCount })}
        </label>
    )
}
