import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Finding } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { findings } from '../schema'

type FindingRow = typeof findings.$inferSelect
type FindingInsert = typeof findings.$inferInsert

// Per-scan input from the worker. Identity + the mutable advisory metadata for this episode.
// Lifecycle fields (firstDetectedAt / lastSeenAt / resolvedAt / id / scanId) are owned by the
// merge function — the caller doesn't choose them.
export type IncomingFinding = {
    projectId: string
    scanner: string
    // Persisted source identity (SourceId; === scanner for today's sources) + the package's EcosystemId.
    source: string
    ecosystem: string
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    packageName: string
    installedVersion: string
    vulnerableRange: string
    severity: Finding['severity']
    fixAvailable: boolean
    fixVersion: string | null
    depPath: string[]
    isProd: boolean
    isDev: boolean
}

export type MergeFindingsInput = {
    projectId: string
    // The scanner this scan belongs to. The merge is scoped to (projectId, scanner): it only ever
    // refreshes / resolves episodes whose scanner matches, so running multiple scanners against the
    // same project is independent — an 'osv' scan never resolves 'npm-audit' findings, and vice versa.
    scanner: string
    scanId: string
    scanFinishedAt: number
    incoming: IncomingFinding[]
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
//   - identity present in DB (open)  + absent from scan -> UPDATE resolved_at = scan.finishedAt
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
    const active: Finding[] = []
    const resolved: Finding[] = []
    const seenIdentityKeys = new Set<string>()
    for (const inc of input.incoming) {
        const key = identityKey(inc.source, inc.ecosystem, inc.advisoryId, inc.packageName)
        seenIdentityKeys.add(key)
        const bucket = openByIdentity.get(key)
        if (bucket && bucket.length > 0) {
            // Keep the earliest-detected row as the continuing episode; resolve any duplicates so a
            // stranded orphan is closed by the same scan that refreshes the real one.
            const canonical = pickOldestRow(bucket)
            db.update(findings)
                .set({
                    advisoryTitle: inc.advisoryTitle,
                    advisoryUrl: inc.advisoryUrl,
                    installedVersion: inc.installedVersion,
                    vulnerableRange: inc.vulnerableRange,
                    severity: inc.severity,
                    fixAvailable: inc.fixAvailable,
                    fixVersion: inc.fixVersion,
                    depPathJson: JSON.stringify(inc.depPath),
                    isProd: inc.isProd,
                    isDev: inc.isDev,
                    lastSeenAt: input.scanFinishedAt
                })
                .where(eq(findings.id, canonical.id))
                .run()
            active.push(rowToFinding({
                ...canonical,
                advisoryTitle: inc.advisoryTitle,
                advisoryUrl: inc.advisoryUrl,
                installedVersion: inc.installedVersion,
                vulnerableRange: inc.vulnerableRange,
                severity: inc.severity,
                fixAvailable: inc.fixAvailable,
                fixVersion: inc.fixVersion,
                depPathJson: JSON.stringify(inc.depPath),
                isProd: inc.isProd,
                isDev: inc.isDev,
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
            vulnerableRange: inc.vulnerableRange,
            severity: inc.severity,
            fixAvailable: inc.fixAvailable,
            fixVersion: inc.fixVersion,
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
            vulnerableRange: inc.vulnerableRange,
            severity: inc.severity,
            fixAvailable: inc.fixAvailable,
            fixVersion: inc.fixVersion,
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
        // Whole identity is gone from the scan: resolve every open row for it, duplicates included.
        for (const row of bucket) {
            resolved.push(resolveFindingRow(db, row, input.scanFinishedAt, input.scanId))
        }
    }
    return { active, resolved }
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
    if (!best) throw new Error('pickOldestRow called with no rows')
    return best
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
    const row = db
        .select({ count: sql<number>`count(*)` })
        .from(findings)
        .where(and(eq(findings.projectId, projectId), isNotNull(findings.resolvedAt)))
        .get()
    return row?.count ?? 0
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
    // Scope to the (ecosystem, packageName) cell when the caller knows the ecosystem; COALESCE keeps
    // un-backfilled legacy rows reachable under 'npm'.
    const ecosystemFilter = ecosystem ? sql`AND COALESCE(f.ecosystem, 'npm') = ${ecosystem}` : sql``
    const rows = db.all<{
        id: string
        scan_id: string
        project_id: string
        scanner: string
        source: string | null
        ecosystem: string | null
        advisory_id: string
        advisory_title: string | null
        advisory_url: string | null
        package_name: string
        installed_version: string
        vulnerable_range: string
        severity: string
        fix_available: number
        fix_version: string | null
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
            ecosystem: row.ecosystem ?? 'npm',
            advisoryId: row.advisory_id,
            advisoryTitle: row.advisory_title,
            advisoryUrl: row.advisory_url,
            packageName: row.package_name,
            installedVersion: row.installed_version,
            vulnerableRange: row.vulnerable_range,
            severity: row.severity as Finding['severity'],
            fixAvailable: row.fix_available === 1,
            fixVersion: row.fix_version,
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

export function findFindingByIdentity(
    db: DrizzleDb,
    identity: { projectId: string; source: string; ecosystem: string; advisoryId: string; packageName: string }
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
    return rowToFinding(row)
}

// In-memory dedup key for the lifecycle merge. First component is the persisted source identity, not
// the scanner plugin name (see findingIdentityKey in ../identity for the durable hashed form).
function identityKey(source: string, ecosystem: string, advisoryId: string, packageName: string): string {
    return source + '|' + ecosystem + '|' + advisoryId + '|' + packageName
}

function rowToFinding(row: FindingRow): Finding {
    return {
        id: row.id,
        scanId: row.scanId,
        projectId: row.projectId,
        scanner: row.scanner,
        // source/ecosystem fall back for the brief pre-backfill window on legacy rows: source === scanner,
        // ecosystem === 'npm' (everything was npm before the polyglot migration).
        source: row.source ?? row.scanner,
        ecosystem: row.ecosystem ?? 'npm',
        advisoryId: row.advisoryId,
        advisoryTitle: row.advisoryTitle,
        advisoryUrl: row.advisoryUrl,
        packageName: row.packageName,
        installedVersion: row.installedVersion,
        vulnerableRange: row.vulnerableRange,
        severity: row.severity,
        fixAvailable: row.fixAvailable,
        fixVersion: row.fixVersion,
        depPath: parseDepPath(row.depPathJson),
        isProd: row.isProd,
        isDev: row.isDev,
        firstDetectedAt: row.firstDetectedAt,
        lastSeenAt: row.lastSeenAt,
        resolvedAt: row.resolvedAt,
        resolvedScanId: row.resolvedScanId
    }
}

function parseDepPath(json: string): string[] {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(function isString(value): value is string {
        return typeof value === 'string'
    })
}
