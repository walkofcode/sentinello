import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Finding } from '@sentinello/core'
import { liveScanners } from './smoke-common'
import { openScratchEnv, type RegistrySnapshotEntry, type RegistryTraffic } from './scratch-env'

// Rescans EVERY project of a scratch copy of the live database through the real runner, timed, for the
// scan-cost measurements. Goes through scratch-env, so it refuses the live data directory and cannot send
// a notification.
//
//   --scratch <db>        the scratch copy (sqlite3 -readonly <live> ".backup <scratch>")
//   --mode disabled       the registry switched off: its URLs point at a refused port and the scratch
//                         registry cache is emptied first, so every npm finding settles `unverified` with
//                         no registry work — the baseline the other modes are compared with
//   --mode cold           the scratch registry cache emptied first, then the live registry
//   --mode expired        the scratch registry cache kept, but every row aged past the 24 h window first —
//                         what the first scan of each day sees; rows with an ETag are revalidated
//   --mode warm           the scratch registry cache kept from the previous run, then the live registry
//   --without-etag        with --mode expired: the cached ETags are forgotten first, so every expired row is
//                         refetched in full — the expired cost without revalidation, for comparison
//   --concurrency <n>     the registry client's request limit (its default when absent)
//   --out <file>          the per-project record (JSON); its directory must exist, and is checked before
//                         the first project is scanned so a bad path never costs a whole fleet run
//
// Per project it records the whole scan's wall time and, separately, the post-scan time: from the last
// scanner's finish to the end of the project run — fix settlement, the way-out guidance and the
// (recording) notifier. That isolates the registry work from `pnpm audit`'s own network time. The summary
// adds what the registry client sent (packument requests, 304s, bytes, failures by reason) and every
// way-out `unknown` verdict grouped by its cause. There is no lookup cap, so a cause naming a budget is a
// regression: the run exits non-zero if it sees one. A progress line per project goes to
// $WOC_PROGRESS_FILE when it is set.

const REFUSED = 'http://127.0.0.1:9'
const MODES = ['disabled', 'cold', 'expired', 'warm'] as const
type Mode = (typeof MODES)[number]
// Past the 24 h freshness window by an hour, so no row is on the boundary.
const EXPIRED_BY_MS = 25 * 60 * 60 * 1000

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
    // Way-out chain verdicts that are `unknown`, by cause (see unknownCause).
    unknownByCause: Record<string, number>
    error: string | null
}

async function main(): Promise<number> {
    const { values } = parseArgs({ options: { scratch: { type: 'string' }, mode: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string' }, 'without-etag': { type: 'boolean' } } })
    const mode = values.mode as Mode
    const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency)
    const withoutEtag = values['without-etag'] === true
    if (!values.scratch || !MODES.includes(mode) || (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) || (withoutEtag && mode !== 'expired')) {
        console.error('usage: fleet-rescan.ts --scratch <db> --mode disabled|cold|expired|warm [--without-etag (expired only)] [--concurrency <n>] [--out <file>]')
        return 2
    }
    const out = values.out === undefined ? null : resolve(values.out)
    if (out !== null && !(existsSync(dirname(out)) && statSync(dirname(out)).isDirectory())) {
        console.error('--out: the directory ' + dirname(out) + ' does not exist; nothing was scanned')
        return 2
    }
    if (mode === 'disabled') {
        process.env.SENTINELLO_NPM_REGISTRY_URL = REFUSED
        process.env.SENTINELLO_NPM_DOWNLOADS_URL = REFUSED
    }
    const env = await openScratchEnv({ db: values.scratch, concurrency })
    try {
        if (mode === 'disabled' || mode === 'cold') env.clearRegistryCache()
        if (mode === 'expired') env.ageRegistryCache(EXPIRED_BY_MS)
        if (withoutEtag) env.forgetRegistryEtags()
        const cachedAtStart = (env.sqlite.prepare('SELECT count(*) AS n, count(etag) AS tagged FROM registry_packages').get() as { n: number; tagged: number })
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
                    unknownByCause: countBy(unknownReasons(findings).map(unknownCause)),
                    error: null
                }
                for (const reason of unknownReasons(findings)) rawReasons.set(reason, (rawReasons.get(reason) ?? 0) + 1)
            } catch (err) {
                record = { id: project.id, name: project.name, scanMs: Date.now() - t0, postScanMs: 0, findings: 0, fixStatus: {}, registry: {}, maxReleases: 0, wayOuts: 0, unknownByCause: {}, error: err instanceof Error ? err.message : String(err) }
            }
            records.push(record)
            progress(mode, records.length, projects.length, records, env.traffic)
        }
        const totalMs = Date.now() - started
        const unknownByCause = merge(records.map(function u(r) { return r.unknownByCause }))
        const summary = {
            recordedAt: new Date().toISOString(),
            mode,
            withoutEtag,
            concurrency: concurrency ?? 'default',
            database: env.dbPath,
            cachedRowsAtStart: cachedAtStart.n,
            cachedRowsWithEtagAtStart: cachedAtStart.tagged,
            projects: records.length,
            totalMs,
            scanMs: sum(records, 'scanMs'),
            postScanMs: sum(records, 'postScanMs'),
            findings: sum(records, 'findings'),
            fixStatus: merge(records.map(function f(r) { return r.fixStatus })),
            registry: merge(records.map(function r(x) { return x.registry })),
            traffic: env.traffic,
            wayOuts: sum(records, 'wayOuts'),
            unknownVerdicts: Object.values(unknownByCause).reduce(function add(n, c) { return n + c }, 0),
            unknownByCause,
            topUnknownReasons: [...rawReasons.entries()].sort(function byCount(a, b) { return b[1] - a[1] }).slice(0, 15).map(function pair([reason, count]) { return { reason, count } }),
            errors: records.filter(function e(r) { return r.error !== null }).length,
            notificationsRecorded: env.notifications.length
        }
        console.log(JSON.stringify(summary, null, 2))
        const slowest = [...records].sort(function byPost(a, b) { return b.postScanMs - a.postScanMs }).slice(0, 10)
        console.log('slowest post-scan (settlement + way out):')
        for (const r of slowest) console.log('  ' + String(r.postScanMs).padStart(7) + ' ms  ' + r.name + '  (' + r.findings + ' findings, ' + r.wayOuts + ' way-outs, max ' + r.maxReleases + ' releases, registry ' + JSON.stringify(r.registry) + ')')
        if (out !== null) writeFileSync(out, JSON.stringify({ summary, projects: records }, null, 2) + '\n')
        const budgeted = unknownByCause.budget ?? 0
        if (budgeted > 0) console.error(budgeted + ' way-out verdicts are unknown because of a budget; the way out has no cap any more')
        return summary.errors === 0 && budgeted === 0 ? 0 : 1
    } finally {
        env.close()
    }
}

const rawReasons = new Map<string, number>()

function unknownReasons(findings: Finding[]): string[] {
    const out: string[] = []
    for (const f of findings) {
        for (const chain of f.remediation?.chains ?? []) {
            if (chain.verdict.kind === 'unknown') out.push(chain.verdict.reason)
        }
    }
    return out
}

// The cause an `unknown` reason names, from the phrasing the way out and the closure walk use. 'budget'
// must never appear; 'other' would mean a reason this list does not know yet.
const CAUSES: [string, RegExp][] = [
    ['budget', /budget/i],
    ['registry error', /HTTP \d|fetch failed|timeout|aborted|unreadable|no registry answer|no cached packument/i],
    ['not on the registry', /not on the npm registry/],
    ['range nothing satisfies', /matches no published release/],
    ['git or file specifier', /not a registry range/],
    ['release not on the registry', /is not a published release/],
    ['installed version is not a release', /is not a release version/],
    ['parent does not declare it', /does not declare/],
    ['version in the closure unresolved', /could not be resolved/],
    ['affected range unreadable', /affected range could not be evaluated/],
    ['no lockfile graph or path', /no lockfile dependency graph|no dependency path/],
    ['no registry data', /no registry data for/]
]

function unknownCause(reason: string): string {
    for (const [cause, pattern] of CAUSES) if (pattern.test(reason)) return cause
    return 'other'
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

function sum(records: ProjectRecord[], key: 'scanMs' | 'postScanMs' | 'findings' | 'wayOuts'): number {
    return records.reduce(function add(n, r) { return n + r[key] }, 0)
}

function maxReleases(served: RegistrySnapshotEntry[]): number {
    return served.reduce(function most(n, e) { return Math.max(n, e.summary ? Object.keys(e.summary.versions).length : 0) }, 0)
}

function progress(mode: Mode, done: number, total: number, records: ProjectRecord[], traffic: RegistryTraffic): void {
    const file = process.env.WOC_PROGRESS_FILE
    const unknown = records.reduce(function add(n, r) { return n + Object.values(r.unknownByCause).reduce(function a(m, c) { return m + c }, 0) }, 0)
    const line = new Date().toTimeString().slice(0, 5) + ' fleet-rescan ' + mode + ' ' + done + '/' + total + ' · found ' + sum(records, 'findings') + ' findings, ' +
        sum(records, 'wayOuts') + ' way-outs, ' + unknown + ' unknown verdicts · ' + traffic.packumentRequests + ' packument requests (' + traffic.notModified + ' 304), ' +
        Math.round(traffic.bytes / 1_000_000) + ' MB · post-scan ' + Math.round(sum(records, 'postScanMs') / 1000) + ' s\n'
    if (file) appendFileSync(file, line)
    if (done % 10 === 0 || done === total) process.stdout.write(line)
}

main().then(function exit(code) {
    process.exit(code)
}, function crash(err: unknown) {
    console.error(err)
    process.exit(1)
})
