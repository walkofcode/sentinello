import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { escalatedSeverity, installedThrough, parseFindingCorroborations, parseFindingInstallations, parseRemediation, readFixFields, requireComparator, type EcosystemId, type FixCheck, type FixFields, type FixStatus, type Finding, type FindingCorroboration, type FindingInstallation, type FindingScanContext, type Remediation } from '@sentinello/core'
import { compareVersions } from '@sentinello/versions'
import type { DrizzleDb } from '../client'
import { findings } from '../schema'
import { sumCount } from './count'
import type { FindingScanContextLookup } from './scan-state'

type FindingRow = typeof findings.$inferSelect
type FindingInsert = typeof findings.$inferInsert

// Per-scan input from the worker. Identity + the mutable advisory metadata for this episode.
// Lifecycle fields (firstDetectedAt / lastSeenAt / resolvedAt / id / scanId) are owned by the
// merge function — the caller doesn't choose them.
export type IncomingFinding = {
    projectId: string
    scanner: string
    // Persisted source identity (SourceId; === scanner for today's sources) + the package's EcosystemId,
    // always explicit: a finding identity never falls back to npm.
    source: string
    ecosystem: EcosystemId
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    packageName: string
    // The lowest affected installed version; every (manifest, version) is in `installations`.
    installedVersion: string
    installations: FindingInstallation[]
    vulnerableRange: string
    severity: Finding['severity']
    // The fix the source STATES. Written unsettled (fix_status NULL) and settled by applyFixSettlement
    // once every source has run; until then readers withhold it.
    fixAvailable: boolean
    fixVersion: string | null
    depPath: string[]
    isProd: boolean
    isDev: boolean
}

export type MergeFindingsInput = {
    projectId: string
    // The cell this scan belongs to. The merge is scoped to (projectId, scanner, ecosystem): it only ever
    // refreshes / resolves episodes of that cell, so the cells scanning one project are independent — an
    // 'osv' scan never resolves 'npm-audit' findings, and OSV's Ruby scan never resolves OSV's Python
    // findings (SENTINEL-122): an empty Ruby result says nothing about Python.
    scanner: string
    ecosystem: EcosystemId
    scanId: string
    scanFinishedAt: number
    incoming: IncomingFinding[]
    // The cell's manifests this scan could not read (resolved `unauditable`: missing, unparseable, unreadable,
    // or a bare manifest whose lockfile is gone), as ProjectManifest paths. The scan's ok status speaks only for
    // the manifests it read: a copy installed through one of these — through its directory, whatever manifest
    // the directory held when the copy was seen (installedThrough) — was not re-checked, so the merge neither
    // resolves its finding nor drops it from a finding it saw elsewhere (SENTINEL-138, decision #51). Empty or
    // absent when every manifest was read.
    unreadManifests?: readonly string[]
}

export type MergeFindingsResult = {
    // Findings active after the merge (newly inserted episodes + continuing episodes), in the
    // same order as the incoming array. Used by the notifier to upsert the discovery ledger.
    active: Finding[]
    // Episodes that were open before this scan but absent from the incoming list — now closed.
    resolved: Finding[]
}

// Merge a scan's findings into the per-project lifecycle table. Must run inside the same
// transaction as insertScan(scan) so the scan row and its lifecycle effects commit atomically.
//
// Behaviour (only invoke for status='ok' scans):
//   - identity present in DB (open)  + present in scan  -> UPDATE last_seen_at + mutable fields
//   - identity NOT present (or only resolved rows) + present in scan -> INSERT new open episode
//   - identity present in DB (open)  + absent from scan -> UPDATE resolved_at = scan.finishedAt, unless a copy
//     was installed through a manifest the scan could not read (or its row predates installations and some
//     manifest went unread): then it is kept open, untouched, because nothing re-checked it
//
// Duplicate self-heal: an identity should have at most one open row, but historical inserts could
// leave several. We bucket ALL open rows per identity (never overwrite): on a match we keep the
// earliest-detected row as the continuing episode and resolve the rest as duplicates; on an absence we
// resolve every row in the bucket. So a single scan after upgrade collapses any stranded duplicates —
// no migration needed. (The previous Map<key,row> kept only the last duplicate, leaking the others as
// permanently-open orphans that no scan could ever close.)
//
// On non-ok scans, do not call this — leave prior findings untouched.
export function mergeFindingsForScan(db: DrizzleDb, input: MergeFindingsInput): MergeFindingsResult {
    const openRows = db
        .select()
        .from(findings)
        .where(
            and(
                eq(findings.projectId, input.projectId),
                eq(findings.scanner, input.scanner),
                eq(findings.ecosystem, input.ecosystem),
                isNull(findings.resolvedAt)
            )
        )
        .all()
    const openByIdentity = new Map<string, FindingRow[]>()
    for (const row of openRows) {
        // Identity keys on the persisted `source` (falling back to scanner for un-backfilled legacy
        // rows), never the scanner plugin name. The merge is still SCOPED to one scanner (the WHERE
        // above) for provenance — an osv scan never resolves npm-audit findings — but within that
        // scope the dedup/identity axis is source.
        const key = identityKey(row.source ?? row.scanner, row.ecosystem, row.advisoryId, row.packageName)
        const bucket = openByIdentity.get(key)
        if (bucket) bucket.push(row)
        else openByIdentity.set(key, [row])
    }
    const unread = input.unreadManifests ?? []
    const active: Finding[] = []
    const resolved: Finding[] = []
    const seenIdentityKeys = new Set<string>()
    for (const inc of input.incoming) {
        // A finding of another cell would be merged against episodes this merge never read, and resolve
        // nothing it should: a defect in the caller, not something to persist quietly.
        if (inc.ecosystem !== input.ecosystem) throw new Error('mergeFindingsForScan: a ' + inc.ecosystem + ' finding in the ' + input.ecosystem + ' cell\'s merge')
        const key = identityKey(inc.source, inc.ecosystem, inc.advisoryId, inc.packageName)
        seenIdentityKeys.add(key)
        const bucket = openByIdentity.get(key)
        if (bucket && bucket.length > 0) {
            // Keep the earliest-detected row as the continuing episode; resolve any duplicates so a
            // stranded orphan is closed by the same scan that refreshes the real one.
            const canonical = pickOldestRow(bucket)
            const { installedVersion, installations, depPath, isProd, isDev } = withRetainedCopies(inc, canonical, unread)
            db.update(findings)
                .set({
                    advisoryTitle: inc.advisoryTitle,
                    advisoryUrl: inc.advisoryUrl,
                    installedVersion,
                    installationsJson: JSON.stringify(installations),
                    vulnerableRange: inc.vulnerableRange,
                    severity: inc.severity,
                    fixAvailable: inc.fixAvailable,
                    fixVersion: inc.fixVersion,
                    // Unsettled until applyFixSettlement runs for this scan: last scan's verdict was about
                    // last scan's evidence, and must not outlive it if settlement never completes.
                    fixStatus: null,
                    fixCheckJson: null,
                    remediationJson: null,
                    depPathJson: JSON.stringify(depPath),
                    isProd,
                    isDev,
                    lastSeenAt: input.scanFinishedAt
                })
                .where(eq(findings.id, canonical.id))
                .run()
            active.push(rowToFinding({
                ...canonical,
                advisoryTitle: inc.advisoryTitle,
                advisoryUrl: inc.advisoryUrl,
                installedVersion,
                installationsJson: JSON.stringify(installations),
                vulnerableRange: inc.vulnerableRange,
                severity: inc.severity,
                fixAvailable: inc.fixAvailable,
                fixVersion: inc.fixVersion,
                fixStatus: null,
                fixCheckJson: null,
                remediationJson: null,
                depPathJson: JSON.stringify(depPath),
                isProd,
                isDev,
                lastSeenAt: input.scanFinishedAt
            }))
            for (const dup of bucket) {
                if (dup.id === canonical.id) continue
                resolved.push(resolveFindingRow(db, dup, input.scanFinishedAt, input.scanId))
            }
            continue
        }
        const id = ulid()
        const insertRow: FindingInsert = {
            id,
            scanId: input.scanId,
            projectId: input.projectId,
            scanner: inc.scanner,
            source: inc.source,
            ecosystem: inc.ecosystem,
            advisoryId: inc.advisoryId,
            advisoryTitle: inc.advisoryTitle,
            advisoryUrl: inc.advisoryUrl,
            packageName: inc.packageName,
            installedVersion: inc.installedVersion,
            installationsJson: JSON.stringify(inc.installations),
            vulnerableRange: inc.vulnerableRange,
            severity: inc.severity,
            // Left empty here and rewritten by applyFindingCorroborations at the end of the project
            // scan: a later source cannot have agreed yet at the moment this row is written.
            corroborationsJson: '[]',
            fixAvailable: inc.fixAvailable,
            fixVersion: inc.fixVersion,
            fixStatus: null,
            fixCheckJson: null,
            remediationJson: null,
            depPathJson: JSON.stringify(inc.depPath),
            isProd: inc.isProd,
            isDev: inc.isDev,
            firstDetectedAt: input.scanFinishedAt,
            lastSeenAt: input.scanFinishedAt,
            resolvedAt: null,
            resolvedScanId: null
        }
        db.insert(findings).values(insertRow).run()
        active.push({
            id,
            scanId: input.scanId,
            projectId: input.projectId,
            scanner: inc.scanner,
            source: inc.source,
            ecosystem: inc.ecosystem,
            advisoryId: inc.advisoryId,
            advisoryTitle: inc.advisoryTitle,
            advisoryUrl: inc.advisoryUrl,
            packageName: inc.packageName,
            installedVersion: inc.installedVersion,
            installations: inc.installations,
            vulnerableRange: inc.vulnerableRange,
            severity: inc.severity,
            corroborations: [],
            // Read back exactly as a reader would see the unsettled row.
            ...readFixFields({ fixStatus: null, fixVersion: inc.fixVersion, fixAvailable: inc.fixAvailable, fixCheckJson: null, remediationJson: null }),
            depPath: inc.depPath,
            isProd: inc.isProd,
            isDev: inc.isDev,
            firstDetectedAt: input.scanFinishedAt,
            lastSeenAt: input.scanFinishedAt,
            resolvedAt: null,
            resolvedScanId: null
        })
    }
    for (const [key, bucket] of openByIdentity.entries()) {
        if (seenIdentityKeys.has(key)) continue
        // Whole identity is gone from the scan: resolve every open row for it, duplicates included — except a
        // row the scan could not have seen, which stays open as it was.
        for (const row of bucket) {
            if (installedThroughUnread(parseFindingInstallations(row.installationsJson), unread)) continue
            resolved.push(resolveFindingRow(db, row, input.scanFinishedAt, input.scanId))
        }
    }
    return { active, resolved }
}

// Whether an open row may hide behind a manifest the scan did not read: one of its copies was installed
// through one, or the row predates installations (written before 3.8), so where it lives is unknown.
function installedThroughUnread(installations: readonly FindingInstallation[], unread: readonly string[]): boolean {
    if (unread.length === 0) return false
    if (installations.length === 0) return true
    return installations.some(function inUnread(i) { return installedThrough(i, unread) })
}

type ContinuingFacts = Pick<IncomingFinding, 'installedVersion' | 'installations' | 'depPath' | 'isProd' | 'isDev'>

// A continuing finding's copies: the ones this scan saw, plus the row's earlier ones behind manifests it could
// not read, which are still there as far as anyone knows (decision #51). `installedVersion` stays the lowest
// affected installed version (by the ecosystem's comparator) across all of them. While such a copy is kept,
// what the row said about it is kept too (SENTINEL-145): the evidence that omitted its manifest cannot clear
// production scope or a dependency chain it may be the one to carry, so scope and chains are the row's
// united with this scan's, as decision #42 folds copies. A scan that reads that manifest again writes them
// from what it sees.
function withRetainedCopies(inc: IncomingFinding, row: FindingRow, unread: readonly string[]): ContinuingFacts {
    const seen: ContinuingFacts = { installedVersion: inc.installedVersion, installations: inc.installations, depPath: inc.depPath, isProd: inc.isProd, isDev: inc.isDev }
    if (unread.length === 0) return seen
    // A manifest the scan could not read contributed nothing to it, so no incoming copy is from one.
    const retained = parseFindingInstallations(row.installationsJson).filter(function behindUnread(prior) { return installedThrough(prior, unread) })
    if (retained.length === 0) return seen
    const comparator = requireComparator(inc.ecosystem)
    let installedVersion = inc.installedVersion
    for (const prior of retained) {
        if (compareVersions(prior.version, installedVersion, comparator) < 0) installedVersion = prior.version
    }
    const depPath = inc.depPath.concat(parseDepPath(row.depPathJson).filter(function unseen(step) { return !inc.depPath.includes(step) }))
    return { installedVersion, installations: inc.installations.concat(retained), depPath, isProd: inc.isProd || row.isProd, isDev: inc.isDev || row.isDev }
}

// Resolve a single open row against this scan and return the closed Finding. Shared by the
// duplicate-collapse path and the absent-identity path so both close rows identically.
function resolveFindingRow(db: DrizzleDb, row: FindingRow, scanFinishedAt: number, scanId: string): Finding {
    db.update(findings)
        .set({ resolvedAt: scanFinishedAt, resolvedScanId: scanId, lastSeenAt: row.lastSeenAt })
        .where(eq(findings.id, row.id))
        .run()
    return rowToFinding({ ...row, resolvedAt: scanFinishedAt, resolvedScanId: scanId })
}

// From open rows sharing one identity (duplicates that should never have coexisted), pick the one to
// keep as the continuing episode: the earliest-detected row, so the finding's firstDetectedAt survives
// the collapse. firstDetectedAt can be null on un-backfilled legacy rows — treat null as "newest" so a
// dated row always wins; ties break on id (ULID is chronological, so the smaller id is older).
function pickOldestRow(rows: FindingRow[]): FindingRow {
    let best: FindingRow | undefined
    for (const row of rows) {
        if (!best) {
            best = row
            continue
        }
        const rowAt = row.firstDetectedAt ?? Number.POSITIVE_INFINITY
        const bestAt = best.firstDetectedAt ?? Number.POSITIVE_INFINITY
        if (rowAt < bestAt || (rowAt === bestAt && row.id < best.id)) best = row
    }
    // The one caller guards on `bucket.length > 0`, so the loop above always assigns on its first pass.
    return best as FindingRow
}

// One-shot, idempotent backfill of firstDetectedAt / lastSeenAt for rows written under the old
// snapshot-only model. Because that model wiped findings on every successful scan, every
// surviving row is implicitly the latest snapshot for its project — we can safely seed both
// timestamps from the originating scan's finished_at and leave resolved_at NULL.
export function backfillFindingsLifecycle(db: DrizzleDb): number {
    const result = db.run(sql`
        UPDATE findings
        SET first_detected_at = COALESCE(first_detected_at,
                (SELECT s.finished_at FROM scans s WHERE s.id = findings.scan_id)),
            last_seen_at = COALESCE(last_seen_at,
                (SELECT s.finished_at FROM scans s WHERE s.id = findings.scan_id))
        WHERE first_detected_at IS NULL OR last_seen_at IS NULL
    `)
    return Number(result.changes) || 0
}

export function listFindingsForScan(db: DrizzleDb, scanId: string): Finding[] {
    const rows = db.select().from(findings).where(eq(findings.scanId, scanId)).all()
    return rows.map(rowToFinding)
}

// Episodes this scan closed — i.e. findings whose resolving scan was this one. Pairs with
// listFindingsForScan (which returns episodes this scan first detected) to show, per historical
// scan, exactly what was discovered and what was resolved.
export function listFindingsResolvedInScan(db: DrizzleDb, scanId: string): Finding[] {
    const rows = db.select().from(findings).where(eq(findings.resolvedScanId, scanId)).all()
    return rows.map(rowToFinding)
}

// The ecosystems a project still has open findings in, whatever source found them. The runner runs these
// cells whatever the project's inventory says now: a cell whose manifests are all gone must still run once
// more to resolve what it found, and keeps running until it has (SENTINEL-144).
export function listOpenFindingEcosystems(db: DrizzleDb, projectId: string): string[] {
    const rows = db
        .selectDistinct({ ecosystem: findings.ecosystem })
        .from(findings)
        .where(and(eq(findings.projectId, projectId), isNull(findings.resolvedAt)))
        .all()
    return rows.map(function ecosystem(r) { return r.ecosystem })
}

export function listFindingsForProject(db: DrizzleDb, projectId: string): Finding[] {
    const rows = db.select().from(findings).where(eq(findings.projectId, projectId)).all()
    return rows.map(rowToFinding)
}

export function listResolvedFindingsForProject(
    db: DrizzleDb,
    projectId: string,
    limit = 50,
    offset = 0
): Finding[] {
    const rows = db
        .select()
        .from(findings)
        .where(and(eq(findings.projectId, projectId), isNotNull(findings.resolvedAt)))
        .orderBy(desc(findings.resolvedAt))
        .limit(limit)
        .offset(offset)
        .all()
    return rows.map(rowToFinding)
}

export function countResolvedFindingsForProject(db: DrizzleDb, projectId: string): number {
    return sumCount(
        db
            .select({ count: sql<number>`count(*)` })
            .from(findings)
            .where(and(eq(findings.projectId, projectId), isNotNull(findings.resolvedAt)))
            .all()
    )
}

export type ResolvedLibraryFinding = Finding & {
    projectName: string
}

export function listResolvedFindingsForLibrary(
    db: DrizzleDb,
    packageName: string,
    limit = 50,
    ecosystem?: string
): ResolvedLibraryFinding[] {
    // Scope to the (ecosystem, packageName) cell when the caller knows the ecosystem. findings.ecosystem is
    // NOT NULL and written explicitly, so no legacy fallback is needed.
    const ecosystemFilter = ecosystem ? sql`AND f.ecosystem = ${ecosystem}` : sql``
    const rows = db.all<{
        id: string
        scan_id: string
        project_id: string
        scanner: string
        source: string | null
        // Not nullable (schema.ts findings.ecosystem). Only source is.
        ecosystem: string
        advisory_id: string
        advisory_title: string | null
        advisory_url: string | null
        package_name: string
        installed_version: string
        installations_json: string
        vulnerable_range: string
        severity: string
        corroborations_json: string
        fix_available: number
        fix_version: string | null
        fix_status: string | null
        fix_check_json: string | null
        remediation_json: string | null
        dep_path_json: string
        is_prod: number
        is_dev: number
        first_detected_at: number | null
        last_seen_at: number | null
        resolved_at: number | null
        resolved_scan_id: string | null
        project_name: string
    }>(sql`
        SELECT f.*, p.name AS project_name
        FROM findings f
        INNER JOIN projects p ON p.id = f.project_id
        WHERE f.package_name = ${packageName} AND f.resolved_at IS NOT NULL
          ${ecosystemFilter}
        ORDER BY f.resolved_at DESC
        LIMIT ${limit}
    `)
    return rows.map(function toRow(row): ResolvedLibraryFinding {
        return {
            id: row.id,
            scanId: row.scan_id,
            projectId: row.project_id,
            scanner: row.scanner,
            source: row.source ?? row.scanner,
            ecosystem: row.ecosystem,
            advisoryId: row.advisory_id,
            advisoryTitle: row.advisory_title,
            advisoryUrl: row.advisory_url,
            packageName: row.package_name,
            installedVersion: row.installed_version,
            installations: parseFindingInstallations(row.installations_json),
            vulnerableRange: row.vulnerable_range,
            severity: row.severity as Finding['severity'],
            corroborations: parseFindingCorroborations(row.corroborations_json),
            ...readFixFields({ fixStatus: row.fix_status, fixVersion: row.fix_version, fixAvailable: row.fix_available === 1, fixCheckJson: row.fix_check_json, remediationJson: row.remediation_json }),
            depPath: parseDepPath(row.dep_path_json),
            isProd: row.is_prod === 1,
            isDev: row.is_dev === 1,
            firstDetectedAt: row.first_detected_at,
            lastSeenAt: row.last_seen_at,
            resolvedAt: row.resolved_at,
            resolvedScanId: row.resolved_scan_id,
            projectName: row.project_name
        }
    })
}

// The notifier's read of a finding a pending event names. `scanContext` is required because the row may be
// one a failed scan retained — a retried or backfilled delivery after the project lost its lockfile — and
// without its source's scan context the message would present the old fix as current ("rescan pending").
export function findFindingByIdentity(
    db: DrizzleDb,
    identity: { projectId: string; source: string; ecosystem: string; advisoryId: string; packageName: string },
    scanContext: FindingScanContextLookup
): Finding | null {
    const row = db
        .select()
        .from(findings)
        .where(
            and(
                eq(findings.projectId, identity.projectId),
                // Match on the persisted source identity; COALESCE keeps un-backfilled legacy rows
                // (source NULL) reachable by their scanner value.
                sql`COALESCE(${findings.source}, ${findings.scanner}) = ${identity.source}`,
                eq(findings.ecosystem, identity.ecosystem),
                eq(findings.advisoryId, identity.advisoryId),
                eq(findings.packageName, identity.packageName),
                isNull(findings.resolvedAt)
            )
        )
        .get()
    if (!row) return null
    return rowToFindingInContext(row, scanContext(row.projectId, row.source ?? row.scanner, row.ecosystem, {
        lastSeenAt: row.lastSeenAt,
        resolvedAt: row.resolvedAt,
        installations: parseFindingInstallations(row.installationsJson)
    }))
}

// In-memory dedup key for the lifecycle merge. First component is the persisted source identity, not
// the scanner plugin name (see findingIdentityKey in ../identity for the durable hashed form).
function identityKey(source: string, ecosystem: string, advisoryId: string, packageName: string): string {
    return source + '|' + ecosystem + '|' + advisoryId + '|' + packageName
}

function rowToFinding(row: FindingRow): Finding {
    return rowToFindingInContext(row, null)
}

// `scanContext` is what the row's source last did on its project (readFixFields); null reads it as re-checked.
function rowToFindingInContext(row: FindingRow, scanContext: FindingScanContext | null): Finding {
    return {
        id: row.id,
        scanId: row.scanId,
        projectId: row.projectId,
        scanner: row.scanner,
        // source falls back for the brief pre-backfill window on legacy rows, where source === scanner.
        // ecosystem needs no such fallback: the column is NOT NULL and every writer names it.
        source: row.source ?? row.scanner,
        ecosystem: row.ecosystem,
        advisoryId: row.advisoryId,
        advisoryTitle: row.advisoryTitle,
        advisoryUrl: row.advisoryUrl,
        packageName: row.packageName,
        installedVersion: row.installedVersion,
        installations: parseFindingInstallations(row.installationsJson),
        vulnerableRange: row.vulnerableRange,
        severity: row.severity,
        corroborations: parseFindingCorroborations(row.corroborationsJson),
        ...readFixFields(row, scanContext),
        depPath: parseDepPath(row.depPathJson),
        isProd: row.isProd,
        isDev: row.isDev,
        firstDetectedAt: row.firstDetectedAt,
        lastSeenAt: row.lastSeenAt,
        resolvedAt: row.resolvedAt,
        resolvedScanId: row.resolvedScanId
    }
}

// Degrades rather than throws, in line with the two checks below it. dep_path_json is display-only
// provenance ("which dependency pulled this in"), so a row whose column was corrupted — by a partial
// write, a hand-edited database, or a future writer with a different shape — is worth showing without
// its dep path. Letting JSON.parse escape would instead take down every findings query that touched
// the row, and with it the whole page listing that project.
function parseDepPath(json: string): string[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(json)
    } catch {
        return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed.filter(function isString(value): value is string {
        return typeof value === 'string'
    })
}

// Rewrites the corroboration set for every finding a project scan touched, and reports each one at the
// worst grade any source gave it.
//
// This runs ONCE at the end of a project scan rather than inside each scanner's merge, because every
// scanner persists its own findings in its own transaction — deliberately, so a later scanner never
// resolves an earlier one's findings — which means by the time a later source agrees, the row it agrees
// with is already written. `touchedIds` is every finding active in this scan, so the corroboration set is
// rebuilt in full: a source that stops reporting stops corroborating, instead of leaving a stale badge.
// `severities` reports the grade this call actually persisted for every row whose severity it
// reconsidered. Callers hold in-memory copies of these findings that were built BEFORE the escalation was
// known, and anything reading `severity` off those stale copies — the notifier, which stamps it onto the
// notification event the dispatch filter matches on — would otherwise use the pre-escalation grade. The
// map is the escalation crossing back out, so nothing downstream has to recompute it and reach a
// different answer.
export type ApplyCorroborationsResult = {
    written: number
    severities: Map<string, Finding['severity']>
}

export function applyFindingCorroborations(
    db: DrizzleDb,
    touchedIds: string[],
    byFindingId: Map<string, { own: Finding['severity']; corroborations: FindingCorroboration[] }>
): ApplyCorroborationsResult {
    const severities = new Map<string, Finding['severity']>()
    if (touchedIds.length === 0) return { written: 0, severities }
    let written = 0
    const CHUNK = 500
    db.transaction(function txn(tx) {
        for (let i = 0; i < touchedIds.length; i += CHUNK) {
            for (const id of touchedIds.slice(i, i + CHUNK)) {
                const entry = byFindingId.get(id)
                const corroborations = entry ? entry.corroborations : []
                const values: { corroborationsJson: string; severity?: Finding['severity'] } = {
                    corroborationsJson: JSON.stringify(corroborations)
                }
                // Only the corroborated rows need their severity reconsidered; an uncorroborated one is
                // already reported at its own source's grade.
                if (entry && corroborations.length > 0) {
                    const escalated = escalatedSeverity(entry.own, corroborations)
                    values.severity = escalated
                    severities.set(id, escalated)
                }
                tx.update(findings).set(values).where(eq(findings.id, id)).run()
                written += 1
            }
        }
    })
    return { written, severities }
}


// One finding's settled fix, as the worker decided it after every source ran.
export type FixSettlementWrite = {
    id: string
    fixStatus: FixStatus
    fixVersion: string | null
    fixAvailable: boolean
    fixCheck: FixCheck
}

// Every settlement also clears the row's way-out: one exists only for a 'none_released' finding, and is
// written by applyRemediation right after, from this scan's evidence. Clearing in the same write is what
// keeps a past way-out from outliving a status change (a fix published since the last scan).
export function applyFixSettlement(db: DrizzleDb, settlements: FixSettlementWrite[]): Map<string, FixFields> {
    const persisted = new Map<string, FixFields>()
    if (settlements.length === 0) return persisted
    db.transaction(function txn(tx) {
        for (const s of settlements) {
            const fixCheckJson = JSON.stringify(s.fixCheck)
            tx.update(findings)
                .set({ fixStatus: s.fixStatus, fixVersion: s.fixVersion, fixAvailable: s.fixAvailable, fixCheckJson, remediationJson: null })
                .where(eq(findings.id, s.id))
                .run()
            persisted.set(s.id, readFixFields({ fixStatus: s.fixStatus, fixVersion: s.fixVersion, fixAvailable: s.fixAvailable, fixCheckJson, remediationJson: null }))
        }
    })
    return persisted
}

// Writes each 'none_released' finding's way-out and returns it as a reader will see it. A row that is not
// (or no longer) 'none_released' is left alone and absent from the result, so a caller can never attach
// a way-out to a finding that has a fix.
export function applyRemediation(db: DrizzleDb, writes: { id: string; remediation: Remediation }[]): Map<string, Remediation> {
    const persisted = new Map<string, Remediation>()
    if (writes.length === 0) return persisted
    db.transaction(function txn(tx) {
        for (const w of writes) {
            const remediationJson = JSON.stringify(w.remediation)
            const result = tx.update(findings)
                .set({ remediationJson })
                .where(and(eq(findings.id, w.id), eq(findings.fixStatus, 'none_released')))
                .run()
            const read = result.changes > 0 ? parseRemediation(remediationJson) : null
            if (read) persisted.set(w.id, read)
        }
    })
    return persisted
}
