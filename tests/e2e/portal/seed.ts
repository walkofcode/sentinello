import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Imported by path rather than by workspace specifier: tests/ is not a workspace package and pnpm
// does not hoist, so `@sentinello/db` has no node_modules link here. Reaching the source file
// directly works because ITS own imports (better-sqlite3, drizzle-orm, @sentinello/core) resolve
// from packages/db, where they are installed.
import { sourceEnabledKey } from '../../../packages/core/src/sources'
import { openDb } from '../../../packages/db/src/client'
import { projectId } from '../../../packages/db/src/identity'
import { runMigrations } from '../../../packages/db/src/migrate'
import { setConfigValue, upsertRoot } from '../../../packages/db/src/queries/config'
import { upsertProject } from '../../../packages/db/src/queries/projects'
import { insertScan } from '../../../packages/db/src/queries/scans'
import type { SqliteDb } from '../../../packages/db/src/client'
import { buildFixtureTree, FIXTURE_PROJECTS } from './fixture-tree'
import { seedOsvCache } from './seed-osv'
import { seedRegistryCache } from './seed-registry'
import {
    E2E_DB_PATH,
    E2E_LOCK_DIR,
    E2E_MANIFEST_PATH,
    E2E_TMP_ROOT,
    FIXTURE_VERSION,
    SEEDED,
    type FixtureManifest
} from './paths'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = resolve(HERE, '..', '..', '..', 'packages', 'db', 'drizzle')

// Deliberately relative to now rather than a fixed instant. The dashboard surfaces projects by how
// recently they were scanned, so a hard-coded date drifts into "6mo ago" and the project falls out
// of the default view — the suite would then rot on the calendar rather than on a real regression.
const T0 = Date.now() - 60_000

// proper-lockfile refreshes the lock directory's mtime for as long as the lock is held, so a young
// mtime is an accurate liveness test rather than a guess.
const LOCK_STALE_MS = 30_000

// Builds the environment the portal and the worker share.
//
// It deliberately writes NO projects, scans or findings (one exception, seedEarlierFindings, says why).
// Those come from the worker's own boot sweep,
// which discovers the on-disk tree and scans it through the real code path. That is not merely higher
// fidelity — it is the only correct option now that a real worker runs. discoverProjects matches rows
// by projectId(rootId, relPath) and OVERWRITES name, packageManager, nvmrcVersion, gitBranch and
// ecosystems on every project it walks, deleting any whose id does not match. A hand-written row that
// disagreed by even its name would be silently replaced mid-suite. Letting the scanner produce the
// baseline also removes a whole bug class: a seed inventing a depPath shape, severity casing or
// vulnerableRange string that the real scanner would never emit.
//
// The portal never migrates — apps/web/lib/db.ts states the worker owns the DB lifecycle — so the
// harness migrates here, exactly as the worker would at boot.
export function seedPortalDatabase(): string {
    const dbPath = process.env.SENTINELLO_E2E_DB_PATH || E2E_DB_PATH

    assertNoLiveWorker()

    rmSync(E2E_TMP_ROOT, { recursive: true, force: true })
    mkdirSync(dirname(dbPath), { recursive: true })

    const rootPath = buildFixtureTree()

    const { db, sqlite } = openDb({ dbPath })
    runMigrations(db, { migrationsFolder: MIGRATIONS })

    upsertRoot(db, { id: SEEDED.rootId, path: rootPath, label: SEEDED.rootLabel, createdAt: T0 })

    // OSV on, npm-audit off. npm-audit spawns the package manager and reaches the registry; OSV reads
    // the local cache seeded below. The "at least one source must stay enabled" invariant is enforced
    // in updateSourceCellAction — i.e. on UI writes only — so honouring it here is this seed's job.
    setConfigValue(db, sourceEnabledKey('npm-audit', 'npm'), false)
    setConfigValue(db, sourceEnabledKey('osv', 'npm'), true)

    // A real worker dispatches notifications automatically after EVERY completed scan, which is a
    // wider hazard than the Test-send button the suite is forbidden from clicking. This is the first
    // of four independent layers: postAndRecord returns before it reaches a sender.
    setConfigValue(db, 'dryRunNotify', true)

    // Anchored six hours from now so the cron cannot fire during a run of any plausible length. It is
    // relative for the same reason T0 is; consequently no spec may assert this key's literal value.
    const startHour = (new Date().getHours() + 6) % 24
    setConfigValue(db, 'schedule', { intervalHours: 24, startHour, timezone: 'UTC' })

    setConfigValue(db, 'parallelism', 2)
    // Left off: startLockfileWatcher only runs at worker boot, so enabling it could add
    // nondeterminism to a tree the tests do not modify, and buy nothing.
    setConfigValue(db, 'watcherEnabled', false)

    setConfigValue(db, 'e2e.fixture', { version: FIXTURE_VERSION, rootPath, seededAt: T0 })

    // Fix settlement reads the npm registry after every scan; the worker's registry URLs point at a
    // refused port (playwright.config.ts), so this cache is the only registry the suite has.
    const registry = seedRegistryCache(db, Date.now())

    seedEarlierFindings(db, sqlite)

    sqlite.close()

    const osv = seedOsvCache()

    const manifest: FixtureManifest = {
        version: FIXTURE_VERSION,
        rootId: SEEDED.rootId,
        rootPath,
        seededAt: T0,
        // Computed with the real identity function rather than from a copy of its two-line sha256, so
        // the ids the specs use cannot drift from the ids discovery will write.
        projects: Object.fromEntries(FIXTURE_PROJECTS.map(function toEntry(p) {
            return [p.relPath, projectId(SEEDED.rootId, p.relPath)]
        }))
    }
    writeFileSync(E2E_MANIFEST_PATH, JSON.stringify(manifest, null, 4) + '\n', 'utf8')

    return dbPath + ' (osv advisories=' + osv.count + ', registry packages=' + registry.packages + ')'
}

// The one exception to "the worker writes every project": lost-lockfile's findings come from a scan that
// had a lockfile, which this tree never has. So its row, that earlier ok OSV scan and the two findings it
// left are written here, exactly as the runner would have — one settled (lodash, fixed in 4.17.21) and
// one legacy (minimist, written before settlement existed). The row is keyed by the same projectId
// discovery computes, so discovery updates it rather than replacing it, and the boot sweep's failed scan
// leaves the findings in place, as a failed scan does.
function seedEarlierFindings(db: Parameters<typeof upsertProject>[0], sqlite: SqliteDb): void {
    const id = projectId(SEEDED.rootId, SEEDED.cannotScanProjectName)
    // A week back, well past the 24 h schedule: the worker's boot sweep runs only when the newest scan is
    // older than the interval, and this is the only scan in the database before it.
    const earlier = T0 - 7 * 86_400_000
    upsertProject(db, {
        id,
        rootId: SEEDED.rootId,
        relPath: SEEDED.cannotScanProjectName,
        name: SEEDED.cannotScanProjectName,
        alias: null,
        packageManager: 'npm',
        nvmrcVersion: null,
        gitBranch: null,
        ecosystems: ['npm'],
        muted: false,
        tags: [],
        createdAt: earlier,
        updatedAt: earlier
    })
    const scanId = 'e2e-earlier-ok-scan'
    insertScan(db, {
        id: scanId,
        projectId: id,
        startedAt: earlier - 1000,
        finishedAt: earlier,
        scanner: 'osv',
        source: 'osv',
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 1000,
        errorText: null,
        rawJson: JSON.stringify({ coverage: [{ ecosystem: 'npm', status: 'ok' }] })
    })
    const check = JSON.stringify({
        v: 1, checkedAt: earlier, registry: 'ok', packageDataAsOf: earlier, unevaluable: null,
        sources: [{ source: 'osv', installed: ['4.17.11'], affected: '>=4.0.0 <4.17.21', patched: '>=4.17.21', statedFix: '4.17.21', noPatchedSentinel: false }]
    })
    const insert = sqlite.prepare(
        'INSERT INTO findings (id, scan_id, project_id, scanner, source, ecosystem, advisory_id, advisory_title, advisory_url, package_name,' +
            ' installed_version, vulnerable_range, severity, fix_available, fix_version, fix_status, fix_check_json, dep_path_json, is_prod, is_dev,' +
            ' first_detected_at, last_seen_at)' +
            " VALUES (?, ?, ?, 'osv', 'osv', 'npm', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 0, ?, ?)"
    )
    insert.run('e2e-lost-lodash', scanId, id, 'GHSA-FIXTURE-lodash', 'Fixture: prototype pollution in lodash', 'https://example.invalid/GHSA-FIXTURE-lodash',
        'lodash', '4.17.11', '>=4.0.0 <4.17.21', 'high', '4.17.21', 'released', check, '["lodash"]', earlier, earlier)
    insert.run('e2e-lost-minimist', scanId, id, 'GHSA-FIXTURE-minimist', 'Fixture: prototype pollution in minimist', 'https://example.invalid/GHSA-FIXTURE-minimist',
        'minimist', '1.2.0', '>=1.0.0 <1.2.6', 'low', '1.2.6', null, null, '["minimist"]', earlier, earlier)
}

// Refuses to run while a worker from a previous run still holds the lock.
//
// Without this the seed would delete a HELD lock directory along with the rest of the temp root, and
// the next worker would start alongside the orphan — two workers claiming the same scan_requests,
// producing failures that look like anything but the actual cause. A SIGKILLed Playwright run is all
// it takes to get there.
function assertNoLiveWorker(): void {
    if (!existsSync(E2E_LOCK_DIR)) return
    const age = Date.now() - statSync(E2E_LOCK_DIR).mtimeMs
    if (age >= LOCK_STALE_MS) return
    throw new Error(
        '[e2e] a worker from a previous run still holds ' + E2E_LOCK_DIR + ' (refreshed ' +
        Math.round(age / 1000) + 's ago). Kill it before reseeding — deleting a held lock would let a ' +
        'second worker start alongside it. Try: pkill -f "apps/worker"'
    )
}
