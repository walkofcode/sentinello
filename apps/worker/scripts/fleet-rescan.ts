import { appendFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { liveScanners } from './smoke-common'
import { openScratchEnv, type RegistrySnapshotEntry } from './scratch-env'

// Rescans EVERY project of a scratch copy of the live database through the real runner, timed, for the
// final milestone's cost measurement. Goes through scratch-env, so it refuses the live data directory and
// cannot send a notification.
//
//   --scratch <db>   the scratch copy (sqlite3 -readonly <live> ".backup <scratch>")
//   --mode disabled  the registry switched off: its URLs point at a refused port and the scratch registry
//                    cache is emptied first, so every npm finding settles `unverified` with no registry
//                    work — the baseline the other modes are compared with
//   --mode cold      the scratch registry cache emptied first, then the live registry
//   --mode warm      the scratch registry cache kept from the previous run, then the live registry
//   --out <file>     the per-project record (JSON)
//
// Per project it records the whole scan's wall time and, separately, the post-scan time: from the last
// scanner's finish to the end of the project run — fix settlement, the way-out guidance and the
// (recording) notifier. That isolates the registry work from `pnpm audit`'s own network time. A progress
// line per project goes to $WOC_PROGRESS_FILE when it is set.

const REFUSED = 'http://127.0.0.1:9'
const MODES = ['disabled', 'cold', 'warm'] as const
type Mode = (typeof MODES)[number]

type ProjectRecord = {
    id: string
    name: string
    scanMs: number
    postScanMs: number
    findings: number
    fixStatus: Record<string, number>
    registry: Record<string, number>
    // The longest release list among the registry answers this project's run was served: the input size
    // the way-out walk iterates over.
    maxReleases: number
    wayOuts: number
    partialWayOuts: number
    error: string | null
}

async function main(): Promise<number> {
    const { values } = parseArgs({ options: { scratch: { type: 'string' }, mode: { type: 'string' }, out: { type: 'string' } } })
    const mode = values.mode as Mode
    if (!values.scratch || !MODES.includes(mode)) {
        console.error('usage: fleet-rescan.ts --scratch <db> --mode disabled|cold|warm [--out <file>]')
        return 2
    }
    if (mode === 'disabled') {
        process.env.SENTINELLO_NPM_REGISTRY_URL = REFUSED
        process.env.SENTINELLO_NPM_DOWNLOADS_URL = REFUSED
    }
    const env = await openScratchEnv({ db: values.scratch })
    try {
        if (mode !== 'warm') env.clearRegistryCache()
        const { listProjects, getProjectById } = await import('@sentinello/db')
        const scanners = await liveScanners(env)
        const projects = listProjects(env.db)
        const records: ProjectRecord[] = []
        const started = Date.now()
        for (const listed of projects) {
            const project = getProjectById(env.db, listed.id) ?? listed
            const mark = env.snapshot.length
            const t0 = Date.now()
            let record: ProjectRecord
            try {
                const { outcomes } = await env.scan(project, scanners)
                const end = Date.now()
                const lastScanner = Math.max(...outcomes.map(function finished(o) { return o.scan.finishedAt ?? t0 }))
                const findings = outcomes.flatMap(function f(o) { return o.findings })
                const served = env.snapshot.slice(mark)
                record = {
                    id: project.id,
                    name: project.name,
                    scanMs: end - t0,
                    postScanMs: Math.max(0, end - lastScanner),
                    findings: findings.length,
                    fixStatus: countBy(findings.map(function s(f) { return f.fixStatus })),
                    registry: countBy(served.map(function p(e) { return e.provenance })),
                    maxReleases: maxReleases(served),
                    wayOuts: findings.filter(function w(f) { return f.remediation !== null }).length,
                    partialWayOuts: findings.filter(function p(f) { return f.remediation?.partial === true }).length,
                    error: null
                }
            } catch (err) {
                record = { id: project.id, name: project.name, scanMs: Date.now() - t0, postScanMs: 0, findings: 0, fixStatus: {}, registry: {}, maxReleases: 0, wayOuts: 0, partialWayOuts: 0, error: err instanceof Error ? err.message : String(err) }
            }
            records.push(record)
            progress(mode, records.length, projects.length, records)
        }
        const totalMs = Date.now() - started
        const summary = {
            recordedAt: new Date().toISOString(),
            mode,
            database: env.dbPath,
            projects: records.length,
            totalMs,
            scanMs: sum(records, 'scanMs'),
            postScanMs: sum(records, 'postScanMs'),
            findings: sum(records, 'findings'),
            fixStatus: merge(records.map(function f(r) { return r.fixStatus })),
            registry: merge(records.map(function r(x) { return x.registry })),
            wayOuts: sum(records, 'wayOuts'),
            partialWayOuts: sum(records, 'partialWayOuts'),
            errors: records.filter(function e(r) { return r.error !== null }).length,
            notificationsRecorded: env.notifications.length
        }
        console.log(JSON.stringify(summary, null, 2))
        const slowest = [...records].sort(function byPost(a, b) { return b.postScanMs - a.postScanMs }).slice(0, 10)
        console.log('slowest post-scan (settlement + way out):')
        for (const r of slowest) console.log('  ' + String(r.postScanMs).padStart(7) + ' ms  ' + r.name + '  (' + r.findings + ' findings, ' + r.wayOuts + ' way-outs, max ' + r.maxReleases + ' releases, registry ' + JSON.stringify(r.registry) + ')')
        if (values.out) writeFileSync(values.out, JSON.stringify({ summary, projects: records }, null, 2) + '\n')
        return summary.errors === 0 ? 0 : 1
    } finally {
        env.close()
    }
}

function countBy(keys: (string | null)[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const k of keys) out[k ?? 'null'] = (out[k ?? 'null'] ?? 0) + 1
    return out
}

function merge(counts: Record<string, number>[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const c of counts) for (const [k, n] of Object.entries(c)) out[k] = (out[k] ?? 0) + n
    return out
}

function sum(records: ProjectRecord[], key: 'scanMs' | 'postScanMs' | 'findings' | 'wayOuts' | 'partialWayOuts'): number {
    return records.reduce(function add(n, r) { return n + r[key] }, 0)
}

function maxReleases(served: RegistrySnapshotEntry[]): number {
    return served.reduce(function most(n, e) { return Math.max(n, e.summary ? Object.keys(e.summary.versions).length : 0) }, 0)
}

function progress(mode: Mode, done: number, total: number, records: ProjectRecord[]): void {
    const file = process.env.WOC_PROGRESS_FILE
    const line = new Date().toTimeString().slice(0, 5) + ' fleet-rescan ' + mode + ' ' + done + '/' + total + ' · found ' + sum(records, 'findings') + ' findings, ' +
        sum(records, 'wayOuts') + ' way-outs, post-scan ' + Math.round(sum(records, 'postScanMs') / 1000) + ' s\n'
    if (file) appendFileSync(file, line)
    if (done % 10 === 0 || done === total) process.stdout.write(line)
}

main().then(function exit(code) {
    process.exit(code)
}, function crash(err: unknown) {
    console.error(err)
    process.exit(1)
})
