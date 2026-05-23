import { NextResponse } from 'next/server'
import { getSqlite } from '@/lib/db'
import { getCurrentVersion } from '@/lib/version'

// Container HEALTHCHECK + orchestrator probe endpoint.
// Probes the shared SQLite (asserts both `apps/web` can open the DB AND the worker has
// migrated it — see apps/web/lib/db.ts) with a trivial SELECT 1. No auth: the surface
// is identical to the portal it sits beside.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type HealthBody = {
    ok: boolean
    db: 'up' | 'down'
    uptimeSec: number
    version: string
    error?: string
}

export async function GET() {
    const startedAt = Date.now()
    const body: HealthBody = {
        ok: true,
        db: 'up',
        uptimeSec: Math.round(process.uptime()),
        version: getCurrentVersion()
    }
    try {
        const sqlite = getSqlite()
        const row = sqlite.prepare('SELECT 1 as ok').get() as { ok: number } | undefined
        if (!row || row.ok !== 1) {
            body.ok = false
            body.db = 'down'
            body.error = 'unexpected SELECT 1 result'
        }
    } catch (err) {
        body.ok = false
        body.db = 'down'
        body.error = err instanceof Error && err.message || 'unknown db error'
    }
    const status = body.ok && 200 || 503
    return NextResponse.json(body, {
        status,
        headers: {
            'Cache-Control': 'no-store',
            'X-Health-Latency-Ms': String(Date.now() - startedAt)
        }
    })
}
