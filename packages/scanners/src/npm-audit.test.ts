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
