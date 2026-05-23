'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

type Props = {
    active: boolean
    intervalMs?: number
}

// Mount once per page when an in-flight scan is relevant to anything on that page.
// While `active` is true, calls router.refresh() every `intervalMs` to re-run the server
// component, which re-reads scan_requests and feeds fresh `scanning` props down to the buttons.
// Doing this server-side avoids needing a websocket and keeps scan state authoritative in SQLite.
export function ScanAutoRefresh({ active, intervalMs }: Props) {
    const router = useRouter()
    const tick = intervalMs || 5000
    useEffect(function setup() {
        if (!active) return
        const id = setInterval(function refresh() {
            router.refresh()
        }, tick)
        return function cleanup() {
            clearInterval(id)
        }
    }, [active, tick, router])
    return null
}
