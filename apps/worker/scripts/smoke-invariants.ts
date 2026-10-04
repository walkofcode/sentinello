import semver from 'semver'
import type { FixCheck } from '@sentinello/core'
import type { RecordedNotification, RegistrySnapshotEntry } from './scratch-env'

// The live invariant set. It judges each settled row against the registry data the run ACTUALLY used —
// the recording client's snapshot, fetched this run or served from the cache — so a correct outcome that
// changed because npm published something still passes, while an invented, stale or mis-attributed one
// fails. Every check is made with the `semver` package directly, never through pickReleasedFix or the
// worker's own helpers, so the code is not checking itself.

export const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000

export type InvariantRow = {
    id: string
    source: string
    ecosystem: string
    advisoryId: string
    packageName: string
    installedVersion: string
    severity: string
    // Raw columns, as persisted.
    fixStatus: string | null
    fixVersion: string | null
    fixAvailable: boolean
    fixCheck: FixCheck | null
    remediationJson: string | null
}

export type InvariantListRow = { id: string; fixStatus: string; fixVersion: string | null; fixAvailable: boolean; isMuted: boolean }

export type InvariantInput = {
    runStartedAt: number
    // The registry answers served during THIS run.
    snapshot: RegistrySnapshotEntry[]
    // Every active row of the project.
    rows: InvariantRow[]
    // What list_findings returns for the project.
    listFindings: InvariantListRow[]
    // What get_project_advisory renders for the project.
    exportMarkdown: string
    // What the recording notifier captured during this run.
    notifications: RecordedNotification[]
    // Packages that must still be reported, at severity high: a missing fix never hides a finding.
    present: string[]
}

const REGISTRY_ECOSYSTEM = 'npm'

function parseVersion(raw: string): string | null {
    return semver.valid(raw) ?? semver.valid(semver.coerce(raw))
}

function parseRange(raw: string): semver.Range | null {
    try {
        return new semver.Range(raw, { includePrerelease: true })
    } catch {
        return null
    }
}

function expectedRegistry(entry: RegistrySnapshotEntry): FixCheck['registry'] {
    if (entry.provenance === 'fetched' || entry.provenance === 'cache') return 'ok'
    return entry.provenance
}

// Everything the row's own snapshot says it was settled against, evaluated independently.
type Evidence = { floor: string; affected: semver.Range[]; patched: semver.Range[] } | { unreadable: string }

function evidenceOf(check: FixCheck): Evidence {
    let floor = '0.0.0'
    const affected: semver.Range[] = []
    const patched: semver.Range[] = []
    if (check.sources.length === 0) return { unreadable: 'no sources recorded' }
    for (const source of check.sources) {
        for (const raw of source.installed) {
            const v = parseVersion(raw)
            if (v === null) return { unreadable: 'installed ' + raw + ' does not parse' }
            if (semver.gt(v, floor)) floor = v
        }
        const range = parseRange(source.affected)
        if (range === null) return { unreadable: 'affected ' + source.affected + ' does not parse' }
        affected.push(range)
        if (source.patched !== null) {
            const p = parseRange(source.patched)
            if (p === null) return { unreadable: 'patched ' + source.patched + ' does not parse' }
            patched.push(p)
        }
    }
    return { floor, affected, patched }
}

function publishedReleases(entry: RegistrySnapshotEntry): string[] {
    if (entry.summary === null) return []
    return Object.keys(entry.summary.versions).filter(function release(v) {
        return semver.valid(v) !== null && semver.prerelease(v) === null
    })
}

function qualifies(version: string, ev: { floor: string; affected: semver.Range[]; patched: semver.Range[] }): boolean {
    const v = semver.valid(version)
    if (v === null || semver.prerelease(v) !== null) return false
    if (semver.lt(v, ev.floor)) return false
    if (ev.affected.some(function hits(r) { return r.test(v) })) return false
    return ev.patched.every(function inside(r) { return r.test(v) })
}

export function checkInvariants(input: InvariantInput): string[] {
    const failures: string[] = []
    function fail(row: InvariantRow | null, message: string): void {
        failures.push((row ? row.packageName + ' ' + row.advisoryId + ' [' + row.source + ']: ' : '') + message)
    }
    const served = new Map<string, RegistrySnapshotEntry>()
    for (const entry of input.snapshot) served.set(entry.name, entry)

    // Presence.
    for (const name of input.present) {
        const high = input.rows.filter(function on(r) { return r.packageName === name && r.severity === 'high' })
        if (high.length === 0) fail(null, name + ' has no active row at severity high')
    }

    for (const row of input.rows) {
        const check = row.fixCheck
        // Settlement freshness: settled by this run, not left over.
        if (check === null || row.fixStatus === null) {
            fail(row, 'not settled (fix_status ' + row.fixStatus + ', fix_check_json ' + (check === null ? 'null' : 'set') + ')')
            continue
        }
        if (check.checkedAt < input.runStartedAt) fail(row, 'settled at ' + check.checkedAt + ', before this run started at ' + input.runStartedAt)
        if (row.remediationJson !== null && row.fixStatus !== 'none_released') fail(row, 'carries a way-out although it is ' + row.fixStatus)

        // Data provenance.
        if (row.ecosystem !== REGISTRY_ECOSYSTEM) {
            if (check.registry !== 'skipped') fail(row, 'ecosystem ' + row.ecosystem + ' was not settled as skipped')
            if (row.fixStatus !== 'unverified') fail(row, 'ecosystem ' + row.ecosystem + ' is ' + row.fixStatus + ' without a registry')
            continue
        }
        const entry = served.get(row.packageName)
        if (!entry) {
            fail(row, 'no registry answer was served for ' + row.packageName + ' in this run')
            continue
        }
        if (check.registry !== expectedRegistry(entry)) fail(row, 'registry ' + check.registry + ' but the run served ' + entry.provenance)
        if (check.packageDataAsOf !== entry.checkedAt) fail(row, 'packageDataAsOf ' + check.packageDataAsOf + ' matches no served entry (served ' + entry.checkedAt + ')')
        if (entry.provenance === 'cache' && entry.checkedAt !== null && entry.checkedAt < input.runStartedAt - FRESH_WINDOW_MS) {
            fail(row, 'served from a cache row older than the freshness window and not marked stale')
        }

        // The outcome, judged against that data.
        const ev = evidenceOf(check)
        const releases = publishedReleases(entry)
        const answered = entry.provenance === 'fetched' || entry.provenance === 'cache' || entry.provenance === 'stale'
        if (row.fixStatus === 'released') {
            if (!answered) fail(row, 'released without registry data')
            if (row.fixVersion === null || !releases.includes(row.fixVersion)) fail(row, 'released ' + row.fixVersion + ' is not a published release')
            else if ('unreadable' in ev) fail(row, 'released although its evidence cannot be evaluated: ' + ev.unreadable)
            else if (!qualifies(row.fixVersion, ev)) fail(row, 'released ' + row.fixVersion + ' is affected, below an installed copy, or outside a patched range')
            if (!row.fixAvailable) fail(row, 'released but fix_available is false')
        } else if (row.fixStatus === 'none_released') {
            if (!answered) fail(row, 'none_released without registry data')
            if (row.fixVersion !== null) fail(row, 'none_released carries fix_version ' + row.fixVersion)
            if ('unreadable' in ev) fail(row, 'none_released although its evidence cannot be evaluated: ' + ev.unreadable)
            else {
                const escape = releases.find(function q(v) { return qualifies(v, ev) })
                if (escape !== undefined) fail(row, 'none_released, but published ' + escape + ' qualifies')
            }
        } else if (row.fixStatus === 'unverified') {
            const explained = !answered || check.unevaluable !== null || 'unreadable' in ev
            if (!explained) fail(row, 'unverified although the registry answered and the evidence is evaluable')
        } else {
            fail(row, 'unknown fix_status ' + row.fixStatus)
        }
    }

    checkSurfaces(input, fail)
    return failures
}

// The DB row, list_findings, the export and the notifier must all say the same thing.
function checkSurfaces(input: InvariantInput, fail: (row: InvariantRow | null, message: string) => void): void {
    const listed = new Map(input.listFindings.map(function byId(r) { return [r.id, r] as const }))
    for (const row of input.rows) {
        const l = listed.get(row.id)
        if (!l) {
            fail(row, 'missing from list_findings')
            continue
        }
        if (l.fixStatus !== row.fixStatus || l.fixVersion !== row.fixVersion || l.fixAvailable !== row.fixAvailable) {
            fail(row, 'list_findings says ' + l.fixStatus + ' ' + l.fixVersion + ', the row ' + row.fixStatus + ' ' + row.fixVersion)
        }
    }

    for (const n of input.notifications) {
        n.findings.forEach(function compare(f, i) {
            const row = input.rows.find(function same(r) { return r.id === f.id })
            if (!row) return
            if (f.fixStatus !== row.fixStatus || f.fixVersion !== row.fixVersion || f.fixAvailable !== row.fixAvailable ||
                JSON.stringify(f.fixCheck) !== JSON.stringify(row.fixCheck)) {
                fail(row, 'the notifier was handed ' + f.fixStatus + ' ' + f.fixVersion + ', the row says ' + row.fixStatus + ' ' + row.fixVersion)
            }
            const vuln = n.vulnerabilities[i] as { fixStatus?: unknown; recommendedVersion?: unknown }
            const recommended = row.fixStatus === 'released' ? row.fixVersion : null
            if (vuln.fixStatus !== row.fixStatus || vuln.recommendedVersion !== recommended) {
                fail(row, 'the webhook payload says ' + String(vuln.fixStatus) + ' recommending ' + String(vuln.recommendedVersion))
            }
        })
    }

    // The export merges rows of one vulnerability; judge each entry by the rows it carries.
    const entries = input.exportMarkdown.split('\n### ').slice(1)
    const byEntry = new Map<number, InvariantRow[]>()
    for (const row of input.rows) {
        if (listed.get(row.id)?.isMuted) continue
        const index = entries.findIndex(function carries(e) { return e.includes('`' + row.packageName + '@') && e.includes(row.advisoryId) })
        if (index < 0) {
            fail(row, 'missing from the advisory export')
            continue
        }
        byEntry.set(index, [...(byEntry.get(index) ?? []), row])
    }
    for (const [index, rows] of byEntry) {
        const fixLine = (entries[index] as string).split('\n').find(function isFix(l) { return l.startsWith('- **Fix:** ') }) ?? ''
        const first = rows[0] as InvariantRow
        if (rows.some(function rel(r) { return r.fixStatus === 'released' })) {
            if (!fixLine.startsWith('- **Fix:** upgrade to `')) fail(first, 'released, but the export says: ' + fixLine)
        } else if (rows.every(function none(r) { return r.fixStatus === 'none_released' })) {
            if (!fixLine.includes('**No fixed version released**')) fail(first, 'none_released, but the export says: ' + fixLine)
        } else if (fixLine.includes('upgrade to') || fixLine.includes('No fixed version released')) {
            fail(first, 'unverified, but the export says: ' + fixLine)
        }
    }
}
