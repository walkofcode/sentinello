'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

type Props = {
    // A scan is in flight somewhere, so the page is expected to change soon.
    active: boolean
    activeIntervalMs?: number
    idleIntervalMs?: number
}

const DEFAULT_ACTIVE_MS = 5000
const DEFAULT_IDLE_MS = 60000

// Calls router.refresh() on a timer, which re-runs the server components and feeds fresh props down —
// scan state, finding counts, source sync status. Doing it server-side avoids a websocket and keeps
// SQLite authoritative. Client state survives a refresh (React reconciles rather than remounting), so
// filter selections, open dialogs and half-typed searches are not disturbed.
//
// Two cadences rather than one: fast while a scan is in flight, slow otherwise. The slow one is the
// point — scans also arrive from cron, the watcher and MCP, and before this the dashboard sat stale
// until the operator happened to navigate.
//
// Mounted ONCE, in the root layout. It used to be mounted per page with `active` scoped to that page's
// own scan, which meant every page that forgot to mount it never updated at all.
export function ScanAutoRefresh({ active, activeIntervalMs, idleIntervalMs }: Props) {
    const router = useRouter()
    const tick = active ? (activeIntervalMs || DEFAULT_ACTIVE_MS) : (idleIntervalMs || DEFAULT_IDLE_MS)
    const lastRefreshRef = useRef<number>(0)

    useEffect(function setup() {
        function refresh() {
            lastRefreshRef.current = Date.now()
            router.refresh()
        }
        // A hidden tab has nobody to show the fresh data to, and polling one forever is pure waste. The
        // catch-up on the way back matters as much as the pause: returning to a tab that then sits
        // stale for another full interval is exactly the staleness this component exists to remove.
        function onVisibilityChange() {
            if (document.hidden) return
            if (Date.now() - lastRefreshRef.current >= tick) refresh()
        }
        const id = setInterval(function onTick() {
            if (document.hidden) return
            refresh()
        }, tick)
        document.addEventListener('visibilitychange', onVisibilityChange)
        return function cleanup() {
            clearInterval(id)
            document.removeEventListener('visibilitychange', onVisibilityChange)
        }
    }, [tick, router])

    return null
}
