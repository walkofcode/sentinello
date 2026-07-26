import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Imported by path rather than by workspace specifier: tests/ is not a workspace package and pnpm
// does not hoist, so `@sentinello/db` has no node_modules link here. Reaching the source file
// directly works because ITS own imports (better-sqlite3, drizzle-orm, @sentinello/core) resolve
// from packages/db, where they are installed.
import { openDb } from '../../../packages/db/src/client'
import { runMigrations } from '../../../packages/db/src/migrate'
import { upsertRoot } from '../../../packages/db/src/queries/config'
import { upsertProject } from '../../../packages/db/src/queries/projects'
import { insertScan } from '../../../packages/db/src/queries/scans'
import { mergeFindingsForScan } from '../../../packages/db/src/queries/findings'
import { E2E_DB_PATH, SEEDED } from './paths'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = resolve(HERE, '..', '..', '..', 'packages', 'db', 'drizzle')

// Deliberately relative to now rather than a fixed instant. The dashboard surfaces projects by how
// recently they were scanned, so a hard-coded date drifts into "6mo ago" and the project falls out
// of the default view — the suite would then rot on the calendar rather than on a real regression.
// No assertion depends on the exact value.
const T0 = Date.now() - 60_000

// Builds the database the portal reads. The portal deliberately never migrates — apps/web/lib/db.ts
// states that the worker owns the DB lifecycle — so the harness must do it, exactly as the worker
// would at boot.
export function seedPortalDatabase(): string {
    rmSync(dirname(E2E_DB_PATH), { recursive: true, force: true })
    mkdirSync(dirname(E2E_DB_PATH), { recursive: true })

    const { db, sqlite } = openDb({ dbPath: E2E_DB_PATH })
    runMigrations(db, { migrationsFolder: MIGRATIONS })

    upsertRoot(db, { id: SEEDED.rootId, path: SEEDED.rootPath, label: 'E2E fixtures', createdAt: T0 })

    for (const [id, name, relPath] of [
        [SEEDED.projectId, SEEDED.projectName, 'services/checkout'],
        [SEEDED.cleanProjectId, SEEDED.cleanProjectName, 'sites/docs']
    ] as const) {
        upsertProject(db, {
            id,
            rootId: SEEDED.rootId,
            relPath,
            name,
            alias: null,
            packageManager: 'npm',
            nvmrcVersion: '24.14.0',
            gitBranch: 'main',
            ecosystems: ['npm'],
            muted: false,
            tags: [],
            createdAt: T0,
            updatedAt: T0
        })
    }

    // One project with findings, one clean — so the dashboard has both states to render.
    insertScan(db, {
        id: 'e2e-scan-1',
        projectId: SEEDED.projectId,
        startedAt: T0,
        finishedAt: T0 + 5000,
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 5000,
        errorText: null,
        rawJson: ''
    })

    mergeFindingsForScan(db, {
        projectId: SEEDED.projectId,
        scanner: 'npm-audit',
        scanId: 'e2e-scan-1',
        scanFinishedAt: T0 + 5000,
        incoming: [
            {
                projectId: SEEDED.projectId,
                scanner: 'npm-audit',
                source: 'npm-audit',
                ecosystem: 'npm',
                advisoryId: 'GHSA-FIXTURE-lodash',
                advisoryTitle: 'Fixture: prototype pollution in lodash',
                advisoryUrl: 'https://example.invalid/GHSA-FIXTURE-lodash',
                packageName: 'lodash',
                installedVersion: '4.17.11',
                vulnerableRange: '>=4.0.0 <4.17.21',
                severity: 'high',
                fixAvailable: true,
                fixVersion: '4.17.21',
                depPath: ['lodash'],
                isProd: true,
                isDev: false
            },
            {
                projectId: SEEDED.projectId,
                scanner: 'npm-audit',
                source: 'npm-audit',
                ecosystem: 'npm',
                advisoryId: 'GHSA-FIXTURE-minimist',
                advisoryTitle: 'Fixture: prototype pollution in minimist',
                advisoryUrl: 'https://example.invalid/GHSA-FIXTURE-minimist',
                packageName: 'minimist',
                installedVersion: '1.2.0',
                vulnerableRange: '>=1.0.0 <1.2.6',
                severity: 'low',
                fixAvailable: true,
                fixVersion: '1.2.6',
                depPath: ['minimist'],
                isProd: false,
                isDev: true
            }
        ]
    })

    insertScan(db, {
        id: 'e2e-scan-2',
        projectId: SEEDED.cleanProjectId,
        startedAt: T0,
        finishedAt: T0 + 2000,
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        status: 'ok',
        reasonCode: 'ok',
        durationMs: 2000,
        errorText: null,
        rawJson: ''
    })

    sqlite.close()
    return E2E_DB_PATH
}
