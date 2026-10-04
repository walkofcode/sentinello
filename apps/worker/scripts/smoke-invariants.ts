import semver from 'semver'
import type { FixCheck, Remediation } from '@sentinello/core'
import type { NpmPackageSummary } from '@sentinello/feeds'
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

export type InvariantListRow = { id: string; fixStatus: string; fixVersion: string | null; fixAvailable: boolean; isMuted: boolean; remediation: unknown }

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
    // A run can serve one package more than once (settlement, then the way-out walk). Settlement asks
    // first, so the first answer per package is the one each row was settled from.
    const served = new Map<string, RegistrySnapshotEntry>()
    for (const entry of input.snapshot) if (!served.has(entry.name)) served.set(entry.name, entry)
    const summaries = snapshotSummaries(input.snapshot)

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
        if (row.remediationJson === null && row.fixStatus === 'none_released') fail(row, 'none_released without a way-out')

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
                if (row.remediationJson !== null) checkRemediation(row, check, ev, summaries, fail)
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
        if (JSON.stringify(l.remediation) !== JSON.stringify(rowRemediation(row))) fail(row, 'list_findings carries a different way-out than the row')
    }

    for (const n of input.notifications) {
        n.findings.forEach(function compare(f, i) {
            const row = input.rows.find(function same(r) { return r.id === f.id })
            if (!row) return
            if (f.fixStatus !== row.fixStatus || f.fixVersion !== row.fixVersion || f.fixAvailable !== row.fixAvailable ||
                JSON.stringify(f.fixCheck) !== JSON.stringify(row.fixCheck)) {
                fail(row, 'the notifier was handed a different fix (' + f.fixStatus + ' ' + f.fixVersion + ', checked ' + String(f.fixCheck?.checkedAt) + ') than the row (' + row.fixStatus + ' ' + row.fixVersion + ', checked ' + String(row.fixCheck?.checkedAt) + ')')
            }
            const vuln = n.vulnerabilities[i] as { fixStatus?: unknown; recommendedVersion?: unknown; remediation?: unknown }
            const recommended = row.fixStatus === 'released' ? row.fixVersion : null
            if (vuln.fixStatus !== row.fixStatus || vuln.recommendedVersion !== recommended) {
                fail(row, 'the webhook payload says ' + String(vuln.fixStatus) + ' recommending ' + String(vuln.recommendedVersion))
            }
            const expected = JSON.stringify(rowRemediation(row))
            if (JSON.stringify(f.remediation) !== expected) fail(row, 'the notifier was handed a different way-out than the row')
            if (JSON.stringify(vuln.remediation) !== expected) fail(row, 'the webhook payload carries a different way-out than the row')
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
            const wayOut = (entries[index] as string).includes('\n- **Way out:**')
            const hasRemediation = rows.some(function has(r) { return r.remediationJson !== null })
            if (wayOut !== hasRemediation) fail(first, hasRemediation ? 'has a way-out the export does not show' : 'the export shows a way-out the row does not have')
        } else if (fixLine.includes('upgrade to') || fixLine.includes('No fixed version released')) {
            fail(first, 'unverified, but the export says: ' + fixLine)
        }
    }
}

// ---- The way out, re-checked against the snapshot ------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const UNMAINTAINED_DAYS = 183

function rowRemediation(row: InvariantRow): unknown {
    return row.fixStatus === 'none_released' && row.remediationJson !== null ? JSON.parse(row.remediationJson) : null
}

// Every package summary the run was served, the first one per package.
function snapshotSummaries(snapshot: RegistrySnapshotEntry[]): Map<string, NpmPackageSummary> {
    const out = new Map<string, NpmPackageSummary>()
    for (const e of snapshot) if (e.summary !== null && !out.has(e.name)) out.set(e.name, e.summary)
    return out
}

// What an install of `range` resolves to, re-derived with semver: the highest release satisfying it, the
// latest tag for '', '*' and 'latest'.
function resolveWith(summary: NpmPackageSummary, range: string): string | null {
    const releases = Object.keys(summary.versions)
    const r = range.trim()
    if (r === '' || r === '*' || r === 'latest') return summary.latest !== null && summary.latest in summary.versions ? summary.latest : semver.maxSatisfying(releases, '*')
    return semver.validRange(r) === null ? null : semver.maxSatisfying(releases, r)
}

// The release's resolved dependency closure, walked over the snapshot alone. `missing` names what the
// snapshot could not resolve.
function rewalk(name: string, version: string, summaries: Map<string, NpmPackageSummary>): { nodes: Set<string>; missing: string[] } {
    const nodes = new Set<string>([name + '@' + version])
    const missing: string[] = []
    const queue: [string, string][] = [[name, version]]
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const [n, v] = next
        const summary = summaries.get(n)
        const meta = summary?.versions[v]
        if (!summary || !meta) {
            missing.push(n + '@' + v)
            continue
        }
        const edges = meta.edges === null ? undefined : summary.edges[meta.edges]
        if (!edges) continue
        // npm honours one range per name: optionalDependencies over dependencies over peerDependencies.
        for (const [depName, depRange] of Object.entries({ ...edges.peerDependencies, ...edges.dependencies, ...edges.optionalDependencies })) {
            let child = depName
            let range = depRange
            if (range.startsWith('npm:')) {
                const spec = range.slice(4)
                const at = spec.lastIndexOf('@')
                child = at <= 0 ? spec : spec.slice(0, at)
                range = at <= 0 ? '*' : spec.slice(at + 1)
            }
            const childSummary = summaries.get(child)
            const resolved = childSummary ? resolveWith(childSummary, range) : null
            if (resolved === null) {
                missing.push(child + '@' + range)
                continue
            }
            const key = child + '@' + resolved
            if (nodes.has(key)) continue
            nodes.add(key)
            queue.push([child, resolved])
        }
    }
    return { nodes, missing }
}

function reachesTarget(nodes: Set<string>, target: string, affected: semver.Range[]): boolean {
    for (const node of nodes) {
        const at = node.lastIndexOf('@')
        if (node.slice(0, at) !== target) continue
        const v = node.slice(at + 1)
        if (affected.some(function hit(r) { return r.test(v) })) return true
    }
    return false
}

type Proof = { release: string; closureSize: number }

function checkProof(label: string, proof: Proof, target: string, affected: semver.Range[], summaries: Map<string, NpmPackageSummary>, fail: (message: string) => void): void {
    const at = proof.release.lastIndexOf('@')
    const name = proof.release.slice(0, at)
    const version = proof.release.slice(at + 1)
    if (!summaries.get(name)?.versions[version]) {
        fail(label + ': ' + proof.release + ' is not a published release in the snapshot')
        return
    }
    const walked = rewalk(name, version, summaries)
    if (walked.missing.length > 0) fail(label + ': the closure of ' + proof.release + ' cannot be re-walked from the snapshot (' + walked.missing.slice(0, 3).join(', ') + ')')
    else if (walked.nodes.size !== proof.closureSize) fail(label + ': ' + proof.release + '\'s closure re-walks to ' + walked.nodes.size + ' packages, the proof says ' + proof.closureSize)
    if (reachesTarget(walked.nodes, target, affected)) fail(label + ': ' + proof.release + '\'s closure still reaches an affected ' + target)
}

function checkRemediation(row: InvariantRow, check: FixCheck, ev: { affected: semver.Range[] }, summaries: Map<string, NpmPackageSummary>, failRow: (row: InvariantRow | null, message: string) => void): void {
    function fail(message: string): void {
        failRow(row, 'way-out: ' + message)
    }
    const r = JSON.parse(row.remediationJson as string) as Remediation
    if (r.checkedAt !== check.checkedAt) fail('computed at ' + r.checkedAt + ', not by this settlement (' + check.checkedAt + ')')
    if (r.package !== row.packageName) fail('describes ' + r.package)

    // Health, from the snapshot's own data.
    const summary = summaries.get(row.packageName)
    if (!summary) {
        fail('no snapshot summary for ' + row.packageName)
        return
    }
    let last: number | null = null
    for (const meta of Object.values(summary.versions)) if (meta.publishedAt !== null && (last === null || meta.publishedAt > last)) last = meta.publishedAt
    const installed = check.sources.flatMap(function i(s) { return s.installed })
    const onInstalled = installed.map(function d(v) { return summary.versions[v]?.deprecated ?? null }).find(function some(d) { return d !== null }) ?? null
    const deprecated = onInstalled ?? (summary.latest !== null ? summary.versions[summary.latest]?.deprecated ?? null : null)
    const days = last === null ? null : Math.max(0, Math.floor((r.checkedAt - last) / DAY_MS))
    const unmaintained = deprecated !== null || (days !== null && days >= UNMAINTAINED_DAYS)
    if (r.health.lastPublishAt !== last) fail('health says last publish ' + r.health.lastPublishAt + ', the snapshot ' + last)
    if (r.health.deprecated !== deprecated) fail('health says deprecated ' + String(r.health.deprecated) + ', the snapshot ' + String(deprecated))
    if (r.health.unmaintained !== unmaintained) fail('health says unmaintained ' + r.health.unmaintained + ', the 183-day rule says ' + unmaintained)

    // Every escape and every offered alternative, re-proven; every noEscape, re-refuted.
    for (const chain of r.chains) {
        const v = chain.verdict
        const where = chain.path.join(' › ')
        if (v.kind === 'upgrade' || v.kind === 'blocked') checkProof(where + ' (' + v.kind + ')', v.proof, row.packageName, ev.affected, summaries, fail)
        if (v.kind === 'noEscape') {
            for (const pkg of v.packages) {
                const node = chain.path.find(function on(p) { return p.slice(0, p.lastIndexOf('@')) === pkg })
                const pkgSummary = summaries.get(pkg)
                if (!node || !pkgSummary) {
                    fail(where + ': noEscape names ' + pkg + ', which is not on the path or not in the snapshot')
                    continue
                }
                const installedAt = node.slice(node.lastIndexOf('@') + 1)
                for (const release of Object.keys(pkgSummary.versions)) {
                    if (semver.valid(release) === null || !semver.gt(release, installedAt)) continue
                    if (!reachesTarget(rewalk(pkg, release, summaries).nodes, row.packageName, ev.affected)) fail(where + ': noEscape, but ' + pkg + '@' + release + ' does not reach ' + row.packageName)
                }
            }
        }
    }
    for (const alt of r.alternatives) {
        for (const option of alt.options) {
            if (option.kind === 'module' && option.verified && option.proof) checkProof('alternative ' + option.name, option.proof, row.packageName, ev.affected, summaries, fail)
        }
    }
}
