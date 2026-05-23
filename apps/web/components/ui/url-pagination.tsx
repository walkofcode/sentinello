'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Pagination } from './pagination'

type Props = {
    page: number
    totalPages: number
    totalItems: number
    pageSize: number
    itemLabel: string
    paramName: string
}

// URL-state pagination. Updates a single search param on the current URL via router.replace
// so the surrounding Server Component re-runs its DB query with the new offset.
export function UrlPagination({ paramName, ...rest }: Props) {
    const router = useRouter()
    const pathname = usePathname()
    const sp = useSearchParams()
    function onChange(page: number) {
        const params = new URLSearchParams(sp ? sp.toString() : '')
        if (page <= 1) params.delete(paramName)
        else params.set(paramName, String(page))
        const search = params.toString()
        const url = pathname + (search && '?' + search)
        router.replace(url, { scroll: false })
    }
    return <Pagination {...rest} onChange={onChange} />
}
