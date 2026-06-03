import { NextResponse } from 'next/server'
import { writeFileSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSqlite } from '@/lib/db'
import { resolveDbPath } from '@sentinello/db'

// Container HEALTHCHECK + orchestrator probe endpoint.
// Probes the shared SQLite (asserts both `apps/web` can open the DB AND the worker has
// migrated it — see apps/web/lib/db.ts) with a trivial SELECT 1, AND asserts the data directory is
// writable. The write probe matters because SELECT 1 is read-only: after an upgrade to the non-root
// image a root-owned data volume still reads fine, so health would stay green while every write
// (scans, config, the worker lock) fails with EACCES and the worker crash-loops. Probing a write
// turns that state red. Intentionally unauthenticated (Docker's HEALTHCHECK runs it) and
// intentionally version-free: anyone who can reach the port must not be able to fingerprint the
// running version here. Version lives behind /api/version.

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type HealthBody = {
    ok: boolean
    db: 'up' | 'down'
    dataDir: 'rw' | 'ro'
    uptimeSec: number
    error?: string
}

function probeDataDirWritable(): string | null {
    try {
        const dir = dirname(resolveDbPath())
        const probe = join(dir, '.health-write-probe-' + process.pid)
        writeFileSync(probe, '')
        unlinkSync(probe)
        return null
    } catch (err) {
        const detail = err instanceof Error && err.message || String(err)
        const uid = typeof process.getuid === 'function' ? process.getuid() : -1
        return 'data directory not writable by uid ' + uid +
            ' (root-owned volume after the non-root upgrade? see the README upgrade note): ' + detail
    }
}

export async function GET() {
    const startedAt = Date.now()
    const body: HealthBody = {
        ok: true,
        db: 'up',
        dataDir: 'rw',
        uptimeSec: Math.round(process.uptime())
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
    const writeError = probeDataDirWritable()
    if (writeError) {
        body.ok = false
        body.dataDir = 'ro'
        if (!body.error) body.error = writeError
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
