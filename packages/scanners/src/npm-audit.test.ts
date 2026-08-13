import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { createNpmAuditScanner, detectLockfile, runNpmAudit, type NpmAuditDeps } from './npm-audit'

// The half of the npm-audit scanner that spawns a package manager. Its pure half (schemas,
// normalizers, stderr classifiers) already lives in npm-audit-parse.ts and is covered there; what was
// unreachable until now is the result SHAPING — which of a dozen distinct reason codes a given
// failure becomes.
//
// That distinction is the point of the file. Every branch below returns "no findings", but they mean
// completely different things to an operator: pm_missing is "install pnpm", audit_schema_mismatch is
// "Sentinello needs updating", and status 'ok' with zero findings is "your project is clean". Getting
// one wrong is silent — the scan still succeeds — which is exactly why they are worth pinning.
//
// `spawn` is injected via NpmAuditDeps rather than mocked at module level, mirroring
// createOsvScanner({ lookup, isSeeded, isEnabled }). The fake below is a real EventEmitter with real
// streams, so the data/close/error wiring, the timeout kill and the abort listener all run for real.

type FakeSpawnOptions = {
    stdout?: string
    stderr?: string
    exitCode?: number | null
    // Emit an error instead of closing — how ENOENT actually surfaces.
    error?: Error
    // Emit 'close' as well as 'error'. Node makes no promise that a failed spawn emits only one of
    // them, so the capture has to survive both.
    alsoClose?: boolean
    // Never close, so the timeout or the abort signal is what settles the promise.
    hang?: boolean
}

type SpawnCall = { cmd: string; args: string[]; cwd: string | undefined }

function fakeSpawn(behaviour: FakeSpawnOptions = {}) {
    const calls: SpawnCall[] = []
    const killed: string[] = []

    const spawn = function spawn(cmd: string, args: readonly string[], opts: { cwd?: string }) {
        calls.push({ cmd, args: [...args], cwd: opts.cwd })
        const child = new EventEmitter() as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough }
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        child.stdin = new PassThrough() as unknown as ChildProcess['stdin']
        // A killed process still emits 'close' — that is what settles the capture promise. A double
        // that only recorded the signal would hang both the timeout and the abort test forever.
        child.kill = function kill(signal?: string) {
            killed.push(String(signal))
            setImmediate(function closeAfterKill() {
                child.emit('close', null)
            })
            return true
        } as ChildProcess['kill']

        // Deliver asynchronously so the caller has attached its listeners first, exactly as a real
        // child process does.
        setImmediate(function deliver() {
            if (behaviour.error) {
                child.emit('error', behaviour.error)
                if (behaviour.alsoClose) {
                    child.stdout.end()
                    child.stderr.end()
                    setImmediate(function close() {
                        child.emit('close', behaviour.exitCode === undefined ? null : behaviour.exitCode)
                    })
                }
                return
            }
            if (behaviour.stdout) child.stdout.write(behaviour.stdout)
            if (behaviour.stderr) child.stderr.write(behaviour.stderr)
            child.stdout.end()
            child.stderr.end()
            if (behaviour.hang) return
            setImmediate(function close() {
                child.emit('close', behaviour.exitCode === undefined ? 0 : behaviour.exitCode)
            })
        })
        return child
    }

    return { deps: { spawn } as unknown as NpmAuditDeps, calls, killed }
}

const MODERN_AUDIT = JSON.stringify({
    vulnerabilities: {
        lodash: {
            name: 'lodash',
            severity: 'high',
            isDirect: true,
            via: [{
                source: 1234,
                name: 'lodash',
                title: 'Prototype pollution',
                url: 'https://example.test/advisory/1234',
                severity: 'high',
                range: '<4.17.21'
            }],
            effects: [],
            range: '<4.17.21',
            nodes: ['node_modules/lodash'],
            fixAvailable: { name: 'lodash', version: '4.17.21', isSemVerMajor: false }
        }
    }
})

const PNPM_AUDIT = JSON.stringify({
    actions: [],
    advisories: {
        1234: {
            id: 1234,
            module_name: 'lodash',
            severity: 'high',
            title: 'Prototype pollution',
            url: 'https://example.test/advisory/1234',
            vulnerable_versions: '<4.17.21',
            patched_versions: '>=4.17.21',
            findings: [{ version: '4.17.11', paths: ['lodash'] }]
        }
    }
})

let dir: string

function ctx(overrides: Record<string, unknown> = {}) {
    return { timeoutMs: 5000, useNvm: false, ...overrides } as Parameters<typeof runNpmAudit>[1]
}

async function project(lock: 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock' | null, extra: Record<string, string> = {}): Promise<string> {
    const target = join(dir, 'proj-' + Math.abs(Date.now() % 1e9) + '-' + Object.keys(extra).length + '-' + (lock ?? 'none'))
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        dependencies: { lodash: '^4.17.11' }
    }), 'utf8')
    if (lock === 'package-lock.json') {
        await writeFile(join(target, lock), JSON.stringify({
            name: 'fixture',
            lockfileVersion: 3,
            packages: { '': { name: 'fixture' }, 'node_modules/lodash': { version: '4.17.11' } }
        }), 'utf8')
    } else if (lock) {
        await writeFile(join(target, lock), '', 'utf8')
    }
    for (const [name, content] of Object.entries(extra)) {
        await writeFile(join(target, name), content, 'utf8')
    }
    return target
}

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-npm-audit-'))
    // logCrossCheckDrops writes straight to stderr when the lockfile cross-check discards a finding,
    // which is real behaviour worth keeping but noise in a test run.
    vi.spyOn(process.stderr, 'write').mockImplementation(function silence() {
        return true
    })
})

afterEach(async function teardown() {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
})

describe('detectLockfile', function () {
    it.each([
        ['pnpm-lock.yaml', 'pnpm'],
        ['package-lock.json', 'npm'],
        ['yarn.lock', 'yarn']
    ])('recognises %s as %s', async function (lock, pm) {
        const path = await project(lock as 'package-lock.json')
        expect(await detectLockfile(path)).toMatchObject({ kind: lock, packageManager: pm })
    })

    it('returns null when there is no lockfile', async function () {
        expect(await detectLockfile(await project(null))).toBeNull()
    })

    // Order is priority: a repo carrying both must audit with pnpm, which is what its node_modules
    // was actually built by.
    it('prefers pnpm over npm when both lockfiles are present', async function () {
        const path = await project('package-lock.json', { 'pnpm-lock.yaml': '' })
        expect(await detectLockfile(path)).toMatchObject({ packageManager: 'pnpm' })
    })
})

describe('runNpmAudit — nothing to audit', function () {
    it('is unauditable with no lockfile, and never spawns', async function () {
        const { deps, calls } = fakeSpawn()
        const result = await runNpmAudit(await project(null), ctx(), deps)
        expect(result).toMatchObject({ status: 'unauditable', reasonCode: 'no_lockfile' })
        expect(calls).toEqual([])
    })

    // yarn 1's audit JSON is a different format entirely; auditing it would silently mis-parse.
    it('refuses yarn 1.x rather than mis-parsing its output', async function () {
        const { deps, calls } = fakeSpawn()
        const path = await project('yarn.lock')
        await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'f', packageManager: 'yarn@1.22.19' }), 'utf8')
        const result = await runNpmAudit(path, ctx(), deps)
        expect(result).toMatchObject({ status: 'unauditable', reasonCode: 'yarn_v1_unsupported' })
        expect(calls).toEqual([])
    })

    it('reports an undeterminable yarn version distinctly', async function () {
        const { deps } = fakeSpawn()
        const path = await project('yarn.lock')
        await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'f' }), 'utf8')
        expect(await runNpmAudit(path, ctx(), deps)).toMatchObject({
            status: 'unauditable',
            reasonCode: 'unknown_pm'
        })
    })

    it('audits yarn berry', async function () {
        const { deps, calls } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('yarn.lock')
        await writeFile(join(path, 'package.json'), JSON.stringify({ name: 'f', packageManager: 'yarn@4.1.0' }), 'utf8')
        expect((await runNpmAudit(path, ctx(), deps)).status).toBe('ok')
        expect(calls).toHaveLength(1)
    })
})

describe('runNpmAudit — spawn failures', function () {
    // "install pnpm" — an operator-actionable state, distinct from a broken scan.
    it('reports a missing package manager as unauditable, naming the tool', async function () {
        const { deps } = fakeSpawn({ error: new Error('spawn pnpm ENOENT') })
        const result = await runNpmAudit(await project('pnpm-lock.yaml'), ctx(), deps)
        expect(result).toMatchObject({ status: 'unauditable', reasonCode: 'pm_missing' })
        expect(result.errorText).toContain('pnpm')
    })

    it('reports any other spawn error as an error, not an unauditable project', async function () {
        const { deps } = fakeSpawn({ error: new Error('EACCES permission denied') })
        expect(await runNpmAudit(await project('package-lock.json'), ctx(), deps)).toMatchObject({
            status: 'error',
            reasonCode: 'audit_spawn_error'
        })
    })

    // 'timeout' is its own status, not an error — the portal renders it as "took too long" rather
    // than "the scan is broken", and the distinction survives into the scans table.
    it('kills the child and reports a timeout when the audit hangs', async function () {
        const { deps, killed } = fakeSpawn({ hang: true })
        const result = await runNpmAudit(await project('package-lock.json'), ctx({ timeoutMs: 20 }), deps)
        expect(result).toMatchObject({ status: 'timeout', reasonCode: 'timeout' })
        expect(result.errorText).toContain('20ms')
        expect(killed).toContain('SIGKILL')
    })

    // Shutdown must be able to cut a scan short rather than waiting out the full timeout. Aborting has
    // to wait for the spawn to actually happen: runNpmAudit does async lockfile detection first, and a
    // signal aborted before the listener is attached never fires it.
    it('kills the child when the run is aborted', async function () {
        const controller = new AbortController()
        const { deps, killed, calls } = fakeSpawn({ hang: true })
        const pending = runNpmAudit(
            await project('package-lock.json'),
            ctx({ timeoutMs: 60_000, abortSignal: controller.signal }),
            deps
        )
        await vi.waitFor(function spawned() {
            expect(calls).toHaveLength(1)
        })
        controller.abort()
        await pending
        expect(killed).toContain('SIGKILL')
    })

    it('reports empty output as an error rather than a clean scan', async function () {
        const { deps } = fakeSpawn({ stdout: '' })
        expect(await runNpmAudit(await project('package-lock.json'), ctx(), deps)).toMatchObject({
            status: 'error',
            reasonCode: 'audit_empty_output'
        })
    })

    it('surfaces stderr as the reason when the output was empty', async function () {
        const { deps } = fakeSpawn({ stdout: '', stderr: 'ENOSPC: no space left on device' })
        expect((await runNpmAudit(await project('package-lock.json'), ctx(), deps)).errorText)
            .toContain('ENOSPC')
    })
})

describe('runNpmAudit — output parsing', function () {
    it('parses a modern npm audit report into findings', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const result = await runNpmAudit(await project('package-lock.json'), ctx(), deps)
        expect(result.status).toBe('ok')
        expect(result.reasonCode).toBe('ok')
        expect(result.findings.map(function pkg(f) { return f.packageName })).toEqual(['lodash'])
        expect(result.findings[0]).toMatchObject({ severity: 'high', fixAvailable: true, fixVersion: '4.17.21' })
    })

    it('reports a clean project as ok with no findings', async function () {
        const { deps } = fakeSpawn({ stdout: JSON.stringify({ vulnerabilities: {} }) })
        const result = await runNpmAudit(await project('package-lock.json'), ctx(), deps)
        expect(result).toMatchObject({ status: 'ok', reasonCode: 'ok' })
        expect(result.findings).toEqual([])
    })

    it('reports unparseable JSON distinctly from a schema mismatch', async function () {
        const { deps } = fakeSpawn({ stdout: '{not json' })
        expect(await runNpmAudit(await project('package-lock.json'), ctx(), deps)).toMatchObject({
            status: 'error',
            reasonCode: 'audit_parse_error'
        })
    })

    // "Sentinello needs updating", not "your project is broken".
    it('reports valid JSON in an unexpected shape as a schema mismatch', async function () {
        const { deps } = fakeSpawn({ stdout: JSON.stringify({ vulnerabilities: 'not an object' }) })
        expect(await runNpmAudit(await project('package-lock.json'), ctx(), deps)).toMatchObject({
            status: 'error',
            reasonCode: 'audit_schema_mismatch'
        })
    })

    it('keeps the raw output on a parse failure so the cause is diagnosable', async function () {
        const { deps } = fakeSpawn({ stdout: '{not json' })
        expect((await runNpmAudit(await project('package-lock.json'), ctx(), deps)).rawJson).toBe('{not json')
    })

    // The counterpart to the test above: a SUCCESSFUL run summarises instead of keeping the document.
    // rawJson exists for the advisory-feed sources to record per-ecosystem coverage in (see types.ts —
    // "npm-audit ignores it"), so npm-audit's copy of the raw audit output was never read by anything.
    // On a real instance it averaged 79 KB a row and had grown to 2.1 GB.
    it('summarises a successful run rather than storing the raw audit document', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })

        const result = await runNpmAudit(await project('package-lock.json'), ctx(), deps)

        expect(result.status).toBe('ok')
        expect(result.rawJson).not.toContain('vulnerabilities')
        expect(JSON.parse(result.rawJson)).toEqual({
            source: 'npm-audit',
            packageCount: null,
            findingCount: result.findings.length
        })
    })

    // null rather than 0: the resolver graph is absent for an unresolvable lockfile, and "we could not
    // count the packages" is a different fact from "there are none".
    it('records an unknown package count as null when the lockfile could not be resolved', async function () {
        const { deps } = fakeSpawn({ stdout: JSON.stringify({ vulnerabilities: {} }) })

        const result = await runNpmAudit(await project('package-lock.json'), ctx(), deps)

        expect(JSON.parse(result.rawJson).packageCount).toBeNull()
    })

    // npm 6's {actions, advisories} shape looks superficially like pnpm's. Under an npm lockfile it
    // must be rejected rather than parsed with the wrong schema.
    it('rejects the legacy npm 6 shape under an npm lockfile', async function () {
        const { deps } = fakeSpawn({ stdout: PNPM_AUDIT })
        expect(await runNpmAudit(await project('package-lock.json'), ctx(), deps)).toMatchObject({
            status: 'error',
            reasonCode: 'legacy_npm6_format'
        })
    })

    // The same bytes under a pnpm lockfile are pnpm's CURRENT format and must parse.
    it('parses the identical payload as current pnpm output under a pnpm lockfile', async function () {
        const { deps } = fakeSpawn({ stdout: PNPM_AUDIT })
        const result = await runNpmAudit(await project('pnpm-lock.yaml'), ctx(), deps)
        expect(result.status).toBe('ok')
        expect(result.findings.map(function pkg(f) { return f.packageName })).toEqual(['lodash'])
    })

    it('reports a pnpm schema mismatch under a pnpm lockfile', async function () {
        const { deps } = fakeSpawn({ stdout: JSON.stringify({ advisories: 'nope' }) })
        expect(await runNpmAudit(await project('pnpm-lock.yaml'), ctx(), deps)).toMatchObject({
            status: 'error',
            reasonCode: 'audit_schema_mismatch'
        })
    })
})

describe('runNpmAudit — command selection', function () {
    it.each([
        ['package-lock.json', 'npm'],
        ['pnpm-lock.yaml', 'pnpm']
    ])('runs the %s package manager directly when nvm is not needed', async function (lock, expected) {
        const { deps, calls } = fakeSpawn({ stdout: JSON.stringify({ vulnerabilities: {} }) })
        await runNpmAudit(await project(lock as 'package-lock.json'), ctx({ useNvm: false }), deps)
        expect(calls[0]?.cmd).toBe(expected)
        expect(calls[0]?.args).toContain('audit')
    })

    it('runs in the project directory', async function () {
        const { deps, calls } = fakeSpawn({ stdout: JSON.stringify({ vulnerabilities: {} }) })
        const path = await project('package-lock.json')
        await runNpmAudit(path, ctx(), deps)
        expect(calls[0]?.cwd).toBe(path)
    })

    it('does not read .nvmrc when nvm is switched off', async function () {
        const { deps, calls } = fakeSpawn({ stdout: JSON.stringify({ vulnerabilities: {} }) })
        const path = await project('package-lock.json', { '.nvmrc': '18.0.0' })
        await runNpmAudit(path, ctx({ useNvm: false }), deps)
        expect(calls[0]?.cmd).toBe('npm')
    })

    // A project pinning a Node version the ambient runtime does not match has to run its audit under
    // that version, or the resolver and the audit disagree about what is installed.
    it('wraps the command in bash when the project pins a different Node version', async function () {
        const { deps, calls } = fakeSpawn({ stdout: JSON.stringify({ vulnerabilities: {} }) })
        const path = await project('package-lock.json', { '.nvmrc': '18.0.0' })
        await runNpmAudit(path, ctx({ useNvm: true }), deps)
        expect(calls[0]?.cmd).toBe('bash')
    })

    // Matching the ambient version means the wrapper is pure overhead — a bash spawn and an nvm
    // source per project.
    it('skips the wrapper when .nvmrc matches the running Node', async function () {
        const { deps, calls } = fakeSpawn({ stdout: JSON.stringify({ vulnerabilities: {} }) })
        const path = await project('package-lock.json', { '.nvmrc': process.version })
        await runNpmAudit(path, ctx({ useNvm: true }), deps)
        expect(calls[0]?.cmd).toBe('npm')
    })

    it('tolerates a v-prefixed .nvmrc', async function () {
        const { deps, calls } = fakeSpawn({ stdout: JSON.stringify({ vulnerabilities: {} }) })
        const path = await project('package-lock.json', { '.nvmrc': process.version.replace(/^v/, '') })
        await runNpmAudit(path, ctx({ useNvm: true }), deps)
        expect(calls[0]?.cmd).toBe('npm')
    })
})

describe('runNpmAudit — nvm wrapper failures', function () {
    async function nvmProject(): Promise<string> {
        return await project('package-lock.json', { '.nvmrc': '18.0.0' })
    }

    // bash itself missing is a different fix from the package manager missing, so it gets its own code.
    it('reports a missing bash distinctly from a missing package manager', async function () {
        const { deps } = fakeSpawn({ error: new Error('spawn bash ENOENT') })
        expect(await runNpmAudit(await nvmProject(), ctx({ useNvm: true }), deps)).toMatchObject({
            status: 'error',
            reasonCode: 'bash_missing'
        })
    })

    it('reports a package manager missing after the nvm install', async function () {
        const { deps } = fakeSpawn({ stdout: '', stderr: 'npm: command not found', exitCode: 127 })
        const result = await runNpmAudit(await nvmProject(), ctx({ useNvm: true }), deps)
        expect(result).toMatchObject({ status: 'unauditable', reasonCode: 'pm_missing' })
        expect(result.errorText).toContain('after nvm install')
    })

    it('falls back to the first stderr line for an unrecognised wrapper failure', async function () {
        const { deps } = fakeSpawn({ stdout: '', stderr: 'something went sideways\nmore detail', exitCode: 1 })
        const result = await runNpmAudit(await nvmProject(), ctx({ useNvm: true }), deps)
        expect(result).toMatchObject({ status: 'error', reasonCode: 'audit_unknown_failure' })
        expect(result.errorText).toContain('something went sideways')
    })

    // A non-zero exit with real output is normal: npm audit exits non-zero whenever it finds
    // vulnerabilities. Treating that as a wrapper failure would discard every finding.
    it('parses output normally when the wrapped command exits non-zero WITH output', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT, exitCode: 1 })
        const result = await runNpmAudit(await nvmProject(), ctx({ useNvm: true }), deps)
        expect(result.status).toBe('ok')
        expect(result.findings).toHaveLength(1)
    })
})

describe('createNpmAuditScanner', function () {
    it('returns a plugin named npm-audit', function () {
        expect(createNpmAuditScanner(fakeSpawn().deps).name).toBe('npm-audit')
    })

    it('drives the injected spawn through the plugin interface', async function () {
        const { deps, calls } = fakeSpawn({ stdout: MODERN_AUDIT })
        const plugin = createNpmAuditScanner(deps)
        const result = await plugin.scan(await project('package-lock.json'), ctx())
        expect(result.status).toBe('ok')
        expect(calls).toHaveLength(1)
    })
})

describe('the lockfile snapshot', function () {
    // The snapshot supplies the installed version for each finding, which is what the lockfile
    // cross-check later compares against the advisory's vulnerable range. Every failure below has to
    // degrade to an empty map rather than throw: a scan that cannot read the lockfile should still
    // report what npm-audit said, just without the version-based filtering.
    it.each([
        ['a lockfile that cannot be read', 'package-lock.json', undefined],
        ['invalid JSON', 'package-lock.json', '{not json'],
        ['a shape the schema rejects', 'package-lock.json', JSON.stringify({ packages: 'not an object' })]
    ])('still audits with %s', async function (_label, lock, body) {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project(lock as 'package-lock.json')
        if (body === undefined) {
            // A directory where the file should be: readFile throws EISDIR.
            await rm(join(path, 'package-lock.json'))
            await mkdir(join(path, 'package-lock.json'))
        } else {
            await writeFile(join(path, 'package-lock.json'), body as string, 'utf8')
        }

        const result = await runNpmAudit(path, ctx(), deps)

        expect(result.status).toBe('ok')
    })

    // pnpm and yarn locks are not parsed for a snapshot at all — only package-lock.json is — so the
    // cross-check is skipped for them rather than run against nothing.
    it('reads no snapshot from a pnpm lockfile', async function () {
        const { deps } = fakeSpawn({ stdout: PNPM_AUDIT })
        expect((await runNpmAudit(await project('pnpm-lock.yaml'), ctx(), deps)).status).toBe('ok')
    })

    // lockfileVersion 1 predates the `packages` map entirely — it carried `dependencies` instead. The
    // schema accepts the file, so the absent map has to default to empty rather than being indexed;
    // the audit then runs with no installed versions and the cross-check simply has nothing to filter.
    it('reads an empty snapshot from a lockfile with no packages map', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('package-lock.json')
        await writeFile(join(path, 'package-lock.json'), JSON.stringify({
            name: 'fixture',
            lockfileVersion: 1,
            dependencies: { lodash: { version: '4.17.11' } }
        }), 'utf8')

        const result = await runNpmAudit(path, ctx(), deps)

        expect(result.status).toBe('ok')
        expect(result.findings).toHaveLength(1)
    })

    it('skips the root "" key and entries with no version', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('package-lock.json')
        await writeFile(join(path, 'package-lock.json'), JSON.stringify({
            name: 'fixture',
            lockfileVersion: 3,
            packages: {
                // The root project entry has no version and must not be indexed as a package.
                '': { name: 'fixture' },
                'node_modules/no-version': {},
                'node_modules/lodash': { version: '4.17.11' }
            }
        }), 'utf8')

        const result = await runNpmAudit(path, ctx(), deps)

        expect(result.status).toBe('ok')
        expect(result.findings[0]?.installedVersion).toBe('4.17.11')
    })
})

describe('the dependency classifier', function () {
    // Every finding is labelled prod, dev or both, and that label drives the portal's default filter
    // and the notification env scope. When the resolver graph is available it is authoritative; the
    // package.json fallback below only runs for lockfiles that have no resolver (yarn, or an
    // unparseable one).
    async function auditWith(manifest: Record<string, unknown>, resolvedGraph?: unknown) {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('package-lock.json')
        await writeFile(join(path, 'package.json'), JSON.stringify(manifest), 'utf8')
        return runNpmAudit(path, ctx({ resolvedGraph }), deps)
    }

    it.each([
        ['a direct dependency', { dependencies: { lodash: '^4' } }],
        ['an optional dependency', { optionalDependencies: { lodash: '^4' } }],
        ['a peer dependency', { peerDependencies: { lodash: '^4' } }]
    ])('treats %s as production', async function (_label, manifest) {
        const result = await auditWith({ name: 'f', ...(manifest as object) })
        expect(result.findings[0]).toMatchObject({ isProd: true, isDev: false })
    })

    it('treats a devDependency as dev only', async function () {
        const result = await auditWith({ name: 'f', devDependencies: { lodash: '^4' } })
        expect(result.findings[0]).toMatchObject({ isProd: false, isDev: true })
    })

    // Both lists name it, so production wins: shipping to production is the more severe claim, and
    // labelling it dev-only would hide it behind the portal's default filter.
    it('resolves a package in both lists as production', async function () {
        const result = await auditWith({ name: 'f', dependencies: { lodash: '^4' }, devDependencies: { lodash: '^4' } })
        expect(result.findings[0]).toMatchObject({ isProd: true, isDev: false })
    })

    // The safe default. A package no signal can place stays visible rather than being filed as dev
    // tooling and dropped from the default view — a transitive nobody declared is still shipping.
    it('defaults an unplaceable package to production', async function () {
        const result = await auditWith({ name: 'f' })
        expect(result.findings[0]).toMatchObject({ isProd: true, isDev: false })
    })

    it.each([
        ['an unparseable package.json', '{not json'],
        ['a package.json that is not an object', '"a string"']
    ])('falls through to the default with %s', async function (_label, body) {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('package-lock.json')
        await writeFile(join(path, 'package.json'), body as string, 'utf8')

        const result = await runNpmAudit(path, ctx(), deps)

        expect(result.findings[0]).toMatchObject({ isProd: true, isDev: false })
    })

    // The resolver graph wins outright when present — it knows the whole tree, where package.json
    // only knows the direct dependencies. Here it contradicts the manifest and must still be obeyed.
    it('prefers the resolver graph over the package.json fallback', async function () {
        const graph = {
            classify: function classify() {
                return { isProd: false, isDev: true }
            }
        }
        const result = await auditWith({ name: 'f', dependencies: { lodash: '^4' } }, graph)
        expect(result.findings[0]).toMatchObject({ isProd: false, isDev: true })
    })
})

describe('detecting the yarn major from the lockfile', function () {
    // packageManager in package.json is the preferred signal; these are the fallbacks for a repo that
    // does not set it. Getting this wrong in the permissive direction is the dangerous one: yarn 1's
    // audit JSON is a completely different shape, so auditing it silently mis-parses.
    async function yarnProject(lockBody: string, manifest?: string): Promise<string> {
        const path = await project('yarn.lock')
        await writeFile(join(path, 'yarn.lock'), lockBody, 'utf8')
        if (manifest !== undefined) await writeFile(join(path, 'package.json'), manifest, 'utf8')
        return path
    }

    it('reads yarn 1 from the classic lockfile banner', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await yarnProject('# yarn lockfile v1\n\n\nlodash@^4:\n  version "4.17.11"\n', JSON.stringify({ name: 'f' }))
        expect(await runNpmAudit(path, ctx(), deps)).toMatchObject({ reasonCode: 'yarn_v1_unsupported' })
    })

    it('reads yarn berry from the __metadata block', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await yarnProject('__metadata:\n  version: 8\n', JSON.stringify({ name: 'f' }))
        expect((await runNpmAudit(path, ctx(), deps)).status).toBe('ok')
    })

    // __metadata is matched anywhere in the file, not just the first line, because berry writes a
    // comment header above it.
    it('finds __metadata below a comment header', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await yarnProject('# This file is generated by running "yarn install"\n\n__metadata:\n  version: 8\n', JSON.stringify({ name: 'f' }))
        expect((await runNpmAudit(path, ctx(), deps)).status).toBe('ok')
    })

    // Neither signal present: refuse rather than guess, since guessing wrong on a yarn 1 lock means
    // parsing the wrong JSON shape and reporting nonsense.
    it('refuses when neither package.json nor the lockfile says', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await yarnProject('some: yaml\n', JSON.stringify({ name: 'f' }))
        expect(await runNpmAudit(path, ctx(), deps)).toMatchObject({ reasonCode: 'unknown_pm' })
    })

    it('falls back to the lockfile when package.json cannot be parsed', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await yarnProject('__metadata:\n  version: 8\n', '{not json')
        expect((await runNpmAudit(path, ctx(), deps)).status).toBe('ok')
    })

    it('reports unknown_pm when the lockfile itself cannot be read', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('yarn.lock')
        await writeFile(join(path, 'package.json'), '{not json', 'utf8')
        await rm(join(path, 'yarn.lock'))
        await mkdir(join(path, 'yarn.lock'))
        expect(await runNpmAudit(path, ctx(), deps)).toMatchObject({ reasonCode: 'unknown_pm' })
    })
})

describe('the .nvmrc read', function () {
    // The decision the read feeds: a pin that differs from the running Node re-executes the audit
    // through `bash -lc 'nvm use … && …'`, and one that matches runs the package manager directly.
    // Getting this backwards is silent — the audit still runs, just under the wrong Node.
    it('wraps the audit through bash when .nvmrc names a different version', async function () {
        const { deps, calls } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('package-lock.json', { '.nvmrc': '18.0.0' })
        await runNpmAudit(path, ctx({ useNvm: true }), deps)
        expect(calls[0]?.cmd).toBe('bash')
        expect(calls[0]?.args.join(' ')).toContain('nvm')
    })

    it('runs the audit directly when .nvmrc matches the running version', async function () {
        const { deps, calls } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('package-lock.json', { '.nvmrc': process.version })
        await runNpmAudit(path, ctx({ useNvm: true }), deps)
        expect(calls[0]?.cmd).toBe('npm')
    })

    // The common case: nvm support is on, but the project pins nothing. No pin means no wrapper — the
    // audit must not be routed through bash on the strength of the flag alone.
    it('runs the audit directly when the project has no .nvmrc at all', async function () {
        const { deps, calls } = fakeSpawn({ stdout: MODERN_AUDIT })
        await runNpmAudit(await project('package-lock.json'), ctx({ useNvm: true }), deps)
        expect(calls[0]?.cmd).toBe('npm')
    })

    // A .nvmrc holding nothing but 'v' survives the read (it is non-empty after trimming) but strips to
    // an empty version when compared. That comparison has to be false: treating '' as a match would skip
    // the wrapper and audit under whatever Node happens to be present, silently ignoring the pin.
    it('does not treat a degenerate .nvmrc as matching the running version', async function () {
        const { deps, calls } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('package-lock.json', { '.nvmrc': 'v' })
        await runNpmAudit(path, ctx({ useNvm: true }), deps)
        expect(calls[0]?.cmd).toBe('bash')
    })

    it('ignores a blank .nvmrc rather than wrapping for an empty version', async function () {
        const { deps, calls } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('package-lock.json', { '.nvmrc': '   \n' })
        await runNpmAudit(path, ctx({ useNvm: true }), deps)
        expect(calls[0]?.cmd).not.toBe('bash')
    })

    // A directory named .nvmrc: fileExists says yes, readFile then throws. Both halves have to
    // degrade to "no nvmrc" rather than failing the scan.
    it('ignores an unreadable .nvmrc', async function () {
        const { deps, calls } = fakeSpawn({ stdout: MODERN_AUDIT })
        const path = await project('package-lock.json')
        await mkdir(join(path, '.nvmrc'))
        await runNpmAudit(path, ctx({ useNvm: true }), deps)
        expect(calls[0]?.cmd).not.toBe('bash')
    })
})

describe('spawn failures that mean different things to an operator', function () {
    // Both are ENOENT, and they need completely different advice: pm_missing means "install pnpm",
    // bash_missing means the nvm wrapper cannot run at all. Reporting one as the other sends the
    // operator to fix the wrong thing.
    it('reports a missing package manager as pm_missing', async function () {
        const { deps } = fakeSpawn({ error: new Error('spawn pnpm ENOENT') })
        expect(await runNpmAudit(await project('pnpm-lock.yaml'), ctx(), deps)).toMatchObject({
            status: 'unauditable',
            reasonCode: 'pm_missing'
        })
    })

    it('reports a missing bash as bash_missing when the nvm wrapper is in play', async function () {
        const { deps } = fakeSpawn({ error: new Error('spawn bash ENOENT') })
        const path = await project('package-lock.json', { '.nvmrc': '18.0.0' })
        expect(await runNpmAudit(path, ctx({ useNvm: true }), deps)).toMatchObject({
            status: 'error',
            reasonCode: 'bash_missing'
        })
    })

    it('reports any other spawn error distinctly', async function () {
        const { deps } = fakeSpawn({ error: new Error('EACCES permission denied') })
        expect(await runNpmAudit(await project('package-lock.json'), ctx(), deps)).toMatchObject({
            reasonCode: 'audit_spawn_error'
        })
    })

    it('tolerates a spawn error with no message', async function () {
        const { deps } = fakeSpawn({ error: new Error('') })
        expect(await runNpmAudit(await project('package-lock.json'), ctx(), deps)).toMatchObject({
            reasonCode: 'audit_spawn_error'
        })
    })

    // A failed child can emit BOTH 'error' and 'close'; the capture promise resolves once and the second
    // event must be ignored. The visible consequence of losing that guard is not a crash — resolving an
    // already-resolved promise is a no-op — but the clean-up it fronts running twice: a second
    // clearTimeout and a second removeEventListener on a listener that is already gone. The assertion is
    // on the outcome that survives, which is the FIRST event's classification, not the close code.
    it('settles once when the child both errors and closes', async function () {
        const { deps } = fakeSpawn({ error: new Error('EACCES permission denied'), alsoClose: true, exitCode: 0 })

        const result = await runNpmAudit(await project('package-lock.json'), ctx(), deps)

        expect(result).toMatchObject({ status: 'error', reasonCode: 'audit_spawn_error' })
        expect(result.errorText).toContain('EACCES')
    })
})

describe('the cross-check drop log', function () {
    // Written to stderr, not stdout, because stdout carries the advisory document a user may pipe
    // straight into an agent. Silent when nothing was dropped, so quiet scans stay quiet.
    function stderrLines(): string[] {
        return vi.mocked(process.stderr.write).mock.calls.map(function first(c) { return String(c[0]) })
    }

    it('says nothing when the cross-check dropped nothing', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT })
        await runNpmAudit(await project('package-lock.json'), ctx(), deps)
        expect(stderrLines().some(function m(l) { return l.includes('lockfile cross-check') })).toBe(false)
    })

    // The installed version sits outside the advisory's range, so npm-audit reported a package that
    // an override has already fixed. Dropping it silently would be worse than not dropping it.
    it('names the dropped advisory when one is filtered out', async function () {
        const audit = JSON.stringify({
            vulnerabilities: {
                lodash: {
                    name: 'lodash',
                    severity: 'high',
                    isDirect: true,
                    via: [{ source: 1234, name: 'lodash', title: 'Prototype pollution', url: 'https://example.test/1234', severity: 'high', range: '<4.17.21' }],
                    effects: [],
                    range: '<4.17.21',
                    nodes: ['node_modules/lodash'],
                    fixAvailable: false
                }
            }
        })
        const { deps } = fakeSpawn({ stdout: audit })
        const path = await project('package-lock.json')
        await writeFile(join(path, 'package-lock.json'), JSON.stringify({
            name: 'fixture',
            lockfileVersion: 3,
            // Already past the vulnerable range — an override upgraded it.
            packages: { '': { name: 'fixture' }, 'node_modules/lodash': { version: '4.17.21' } }
        }), 'utf8')

        const result = await runNpmAudit(path, ctx(), deps)

        expect(result.findings).toHaveLength(0)
        expect(stderrLines().some(function m(l) { return l.includes('lockfile cross-check') && l.includes('1234') })).toBe(true)
    })

    // One override can cascade through a large dependency graph and drop dozens of advisories at once.
    // The line names the first ten and counts the rest, because a single stderr line listing a hundred
    // advisory ids is not something anyone reads.
    it('truncates the advisory list and counts the remainder past ten', async function () {
        const vulnerabilities: Record<string, unknown> = {}
        for (let i = 1; i <= 13; i++) {
            const name = 'pkg' + i
            vulnerabilities[name] = {
                name,
                severity: 'high',
                isDirect: true,
                via: [{ source: i, name, title: 'Issue ' + i, url: 'https://example.test/' + i, severity: 'high', range: '<2.0.0' }],
                effects: [],
                range: '<2.0.0',
                nodes: ['node_modules/' + name],
                fixAvailable: false
            }
        }
        const { deps } = fakeSpawn({ stdout: JSON.stringify({ vulnerabilities }) })
        const path = await project('package-lock.json')
        const packages: Record<string, unknown> = { '': { name: 'fixture' } }
        // Every one already past its vulnerable range, so all thirteen are dropped.
        for (let i = 1; i <= 13; i++) packages['node_modules/pkg' + i] = { version: '2.5.0' }
        await writeFile(join(path, 'package-lock.json'), JSON.stringify({
            name: 'fixture',
            lockfileVersion: 3,
            packages
        }), 'utf8')

        const result = await runNpmAudit(path, ctx(), deps)

        expect(result.findings).toHaveLength(0)
        const line = stderrLines().find(function m(l) { return l.includes('lockfile cross-check') })
        expect(line).toContain('dropped 13 finding(s)')
        expect(line).toContain('+3 more')
    })
})

describe('nvm wrapper failures', function () {
    // When the wrapper fails there is no audit JSON at all, only bash/nvm stderr, and every one of
    // these reads as "the scan produced nothing" unless it is classified. The distinction the
    // operator needs is whose problem it is: nvm_missing is theirs to install, nvm_install_failed is
    // an upstream Node version or download that will not resolve itself.
    async function wrappedFailure(stderr: string) {
        const { deps } = fakeSpawn({ stderr, exitCode: 1 })
        const path = await project('package-lock.json', { '.nvmrc': '18.0.0' })
        return runNpmAudit(path, ctx({ useNvm: true }), deps)
    }

    it.each([
        ['nvm.sh is absent', 'bash: /home/app/.nvm/nvm.sh: No such file or directory'],
        ['nvm is not a command', 'bash: line 1: nvm: command not found']
    ])('reports %s as unauditable, not an error', async function (_label, stderr) {
        expect(await wrappedFailure(stderr as string)).toMatchObject({
            status: 'unauditable',
            reasonCode: 'nvm_missing'
        })
    })

    it.each([
        ['an unreleased Node version', 'Version "v18.99.99" not found - try `nvm ls-remote` to browse available versions.'],
        ['a failed download', 'Binary download failed, trying source.'],
        ['an install that did not take', 'N/A: version "v18.0.0 -> N/A" is not yet installed.']
    ])('reports %s as an install error', async function (_label, stderr) {
        expect(await wrappedFailure(stderr as string)).toMatchObject({
            status: 'error',
            reasonCode: 'nvm_install_failed'
        })
    })

    // The package manager is missing INSIDE the freshly installed Node, which is a different fix
    // from "pnpm is not on the host PATH" — corepack or a global install in the new version.
    it('reports a package manager missing after the nvm install', async function () {
        const { deps } = fakeSpawn({ stderr: 'bash: line 2: pnpm: command not found', exitCode: 127 })
        const path = await project('pnpm-lock.yaml', { '.nvmrc': '18.0.0' })
        expect(await runNpmAudit(path, ctx({ useNvm: true }), deps)).toMatchObject({
            status: 'unauditable',
            reasonCode: 'pm_missing'
        })
    })

    // Unrecognised stderr still has to say something specific rather than falling through to a bare
    // "empty output", and it is truncated because bash can emit a great deal of it.
    it('quotes the first stderr line for an unrecognised wrapper failure', async function () {
        const result = await wrappedFailure('something entirely unexpected\nand a second line')
        expect(result).toMatchObject({ status: 'error', reasonCode: 'audit_unknown_failure' })
        expect(result.errorText).toContain('something entirely unexpected')
        expect(result.errorText).not.toContain('second line')
    })

    // The wrapper exited non-zero having said nothing on either stream. There is no signature to quote,
    // so the reason has to fall back to a placeholder: an errorText of '' renders in the portal as a
    // failed scan with no explanation at all, which is the one outcome worse than a vague one.
    it('names a silent wrapper failure rather than reporting an empty reason', async function () {
        const result = await wrappedFailure('')
        expect(result).toMatchObject({ status: 'error', reasonCode: 'audit_unknown_failure' })
        expect(result.errorText).toContain('unknown failure')
    })

    // Only when there is NO audit output. A wrapper that exits non-zero but still produced JSON has
    // done its job — npm audit exits 1 whenever it finds anything at all.
    it('ignores a non-zero exit when the wrapper still produced audit JSON', async function () {
        const { deps } = fakeSpawn({ stdout: MODERN_AUDIT, stderr: 'nvm: command not found', exitCode: 1 })
        const path = await project('package-lock.json', { '.nvmrc': '18.0.0' })
        expect((await runNpmAudit(path, ctx({ useNvm: true }), deps)).status).toBe('ok')
    })
})

describe('a vulnerability with no concrete advisory', function () {
    // npm-audit's `via` can hold plain strings (naming another vulnerable package) instead of
    // advisory objects. A report made entirely of those has told us a package is affected but not by
    // what, which is not something the portal can display, dedupe or link — so it is an error rather
    // than a silent zero-finding pass.
    it('reports audit_no_advisories rather than a clean scan', async function () {
        const audit = JSON.stringify({
            vulnerabilities: {
                lodash: {
                    name: 'lodash',
                    severity: 'high',
                    isDirect: false,
                    via: ['some-other-package'],
                    effects: [],
                    range: '<4.17.21',
                    nodes: ['node_modules/lodash'],
                    fixAvailable: false
                }
            }
        })
        const { deps } = fakeSpawn({ stdout: audit })

        expect(await runNpmAudit(await project('package-lock.json'), ctx(), deps)).toMatchObject({
            status: 'error',
            reasonCode: 'audit_no_advisories'
        })
    })

    // The mixed case must NOT error: one concrete advisory is enough to report, and failing the whole
    // scan because a sibling entry was indirect would lose a real finding.
    it('keeps a concrete advisory alongside an indirect one', async function () {
        const audit = JSON.stringify({
            vulnerabilities: {
                lodash: {
                    name: 'lodash',
                    severity: 'high',
                    isDirect: true,
                    via: [{ source: 1234, name: 'lodash', title: 'Prototype pollution', url: 'https://example.test/1234', severity: 'high', range: '<4.17.21' }],
                    effects: [],
                    range: '<4.17.21',
                    nodes: ['node_modules/lodash'],
                    fixAvailable: false
                },
                other: {
                    name: 'other',
                    severity: 'high',
                    isDirect: false,
                    via: ['lodash'],
                    effects: [],
                    range: '*',
                    nodes: ['node_modules/other'],
                    fixAvailable: false
                }
            }
        })
        const { deps } = fakeSpawn({ stdout: audit })

        const result = await runNpmAudit(await project('package-lock.json'), ctx(), deps)

        expect(result.status).toBe('ok')
        expect(result.findings).toHaveLength(1)
    })
})
