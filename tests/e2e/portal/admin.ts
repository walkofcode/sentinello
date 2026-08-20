import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { E2E_DB_PATH, E2E_OSV_DB_PATH, repoRoot } from './paths'

const execFileAsync = promisify(execFile)

// The Playwright-side wrapper around db-admin. It imports only node:* builtins, deliberately.
//
// Specs are loaded by Playwright's own loader, and packages/db is "type": "module" with modules that
// use import.meta.url — the boundary seed-run.ts already documents as a reason to stay in a tsx child.
// Shelling out sidesteps the question entirely for about 500ms per call, which is affordable because
// only the mutating specs reset, and they run one at a time anyway.
//
// If the mutating suite ever grows enough that 500ms per reset matters, this module is the seam:
// promote db-admin to an HTTP webServer entry and keep this signature.

const ROOT = repoRoot()
const RUNNER = resolve(ROOT, 'tests', 'e2e', 'portal', 'db-admin-run.ts')
// cwd matters: better-sqlite3 is installed under packages/db and does not resolve from anywhere else
// in the repo, so the child has to run where the dependency graph reaches it — the same reason
// test:e2e:seed runs through `pnpm --filter @sentinello/worker exec`.
const WORKER_DIR = resolve(ROOT, 'apps', 'worker')

export type Counts = Record<string, number>

export type AdminState = {
    counts: Counts
    fixture: { version: number; rootPath: string; seededAt: number } | null
    inFlight: number
}

async function run(args: string[]): Promise<unknown> {
    const { stdout } = await execFileAsync('node', ['--import', 'tsx', RUNNER, ...args], {
        cwd: WORKER_DIR,
        env: {
            ...process.env,
            SENTINELLO_DB_PATH: E2E_DB_PATH,
            SENTINELLO_OSV_DB_PATH: E2E_OSV_DB_PATH
        }
    })
    return JSON.parse(stdout.trim().split('\n').pop() || '{}')
}

export async function adminState(): Promise<AdminState> {
    return await run(['state']) as AdminState
}

export async function awaitBaseline(timeoutMs: number, expected: Counts): Promise<Counts> {
    return await run(['await-baseline', String(timeoutMs), JSON.stringify(expected)]) as Counts
}

export async function awaitQueueIdle(timeoutMs = 30_000): Promise<void> {
    await run(['await-queue-idle', String(timeoutMs)])
}

export async function resetDb(): Promise<Counts> {
    return await run(['reset']) as Counts
}

export async function findingAges(): Promise<Record<string, number>> {
    return await run(['finding-ages']) as Record<string, number>
}

export async function insertRunningRequest(projectId: string): Promise<string> {
    const out = await run(['insert-running-request', projectId]) as { id: string }
    return out.id
}

export async function enqueueScanRequests(projectId: string, count: number): Promise<string[]> {
    const out = await run(['enqueue-scan-requests', projectId, String(count)]) as { ids: string[] }
    return out.ids
}

export async function deleteRequest(id: string): Promise<void> {
    await run(['delete-request', id])
}

export async function setSourceStatus(source: string, ecosystem: string, status: Record<string, unknown>): Promise<void> {
    await run(['set-source-status', source, ecosystem, JSON.stringify(status)])
}
