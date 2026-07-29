import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import type {
    DetectedLockfile,
    LockfileKind,
    ScanContext,
    ScannerPlugin,
    ScanResult
} from './types'
import { filterFindingsByLockfileResolution } from './lockfile-cross-check'
import type { ResolvedGraph } from './resolver'
// The pure half of this scanner — every JSON schema, the normalizers, and the stderr classifiers —
// lives in npm-audit-parse.ts so it is reachable without spawning a package manager. This module
// keeps only the parts that touch a child process or the filesystem.
import {
    buildBashWrappedCommand,
    classifyNvmWrapperFailure,
    classifyPackageManagerNotFound,
    errorResult,
    looksLikeLegacyShape,
    modernAuditSchema,
    normalizeAuditOutput,
    normalizePnpmAuditOutput,
    packageLockSchema,
    parseYarnMajor,
    pickAuditCommand,
    pnpmAuditSchema,
    timeoutResult,
    unauditableResult
} from './npm-audit-parse'
import type { DepClassifier, InstalledVersionMap } from './npm-audit-parse'

const SCANNER_NAME = 'npm-audit'

type LockfileSnapshot = {
    installedVersions: InstalledVersionMap
}

// Reads the per-node installed versions from a package-lock.json so pickInstalledVersion can resolve a
// vulnerability's audit nodes to concrete versions. Prod/dev classification no longer lives here — that
// is the shared resolver graph's job. Returns an empty map for non-npm locks (fail-open).
async function loadLockfileSnapshot(
    projectPath: string,
    lockfile: DetectedLockfile
): Promise<LockfileSnapshot> {
    const empty: LockfileSnapshot = { installedVersions: new Map() }
    if (lockfile.kind !== 'package-lock.json') return empty
    let text: string
    try {
        text = await readFile(lockfile.absolutePath, 'utf8')
    } catch {
        return empty
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return empty
    }
    const validation = packageLockSchema.safeParse(parsed)
    if (!validation.success) return empty
    const installedVersions: InstalledVersionMap = new Map()
    const packages = validation.data.packages || {}
    for (const nodePath of Object.keys(packages)) {
        if (!nodePath) continue
        const entry = packages[nodePath]
        if (!entry) continue
        if (entry.version) {
            installedVersions.set(nodePath, entry.version)
        }
    }
    return { installedVersions }
}

// Classifies whether a finding's package ships to production, dev tooling, or both. The authoritative
// signal is the shared resolver graph (computed once per project from the lockfile by the runner), looked
// up by package name + installed version. When no graph is available (yarn / unparseable lock) we fall
// back to package.json direct-dep membership by name; a package no signal can place stays visible by
// defaulting to isProd=true.

async function buildDepClassifier(
    projectPath: string,
    graph: ResolvedGraph | null
): Promise<DepClassifier> {
    const prodDirect = new Set<string>()
    const devDirect = new Set<string>()
    try {
        const text = await readFile(join(projectPath, 'package.json'), 'utf8')
        const parsed = JSON.parse(text) as unknown
        if (parsed && typeof parsed === 'object') {
            const obj = parsed as {
                dependencies?: Record<string, unknown>
                devDependencies?: Record<string, unknown>
                optionalDependencies?: Record<string, unknown>
                peerDependencies?: Record<string, unknown>
            }
            if (obj.dependencies) {
                for (const k of Object.keys(obj.dependencies)) prodDirect.add(k)
            }
            if (obj.optionalDependencies) {
                for (const k of Object.keys(obj.optionalDependencies)) prodDirect.add(k)
            }
            if (obj.peerDependencies) {
                for (const k of Object.keys(obj.peerDependencies)) prodDirect.add(k)
            }
            if (obj.devDependencies) {
                for (const k of Object.keys(obj.devDependencies)) devDirect.add(k)
            }
        }
    } catch {
        // No package.json or parse error — sets stay empty, classifier falls through to default.
    }

    function classify(packageName: string, version: string | null): { isProd: boolean; isDev: boolean } {
        if (graph) {
            const scope = graph.classify(packageName, version)
            return { isProd: scope.isProd, isDev: scope.isDev }
        }
        let isProd = prodDirect.has(packageName)
        const isDev = devDirect.has(packageName) && !isProd
        if (!isProd && !isDev) isProd = true
        return { isProd, isDev }
    }

    return { classify }
}

type SpawnResult = {
    stdout: string
    stderr: string
    exitCode: number | null
    timedOut: boolean
    spawnError: Error | null
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await access(p, fsConstants.F_OK)
        return true
    } catch {
        return false
    }
}

export async function detectLockfile(projectPath: string): Promise<DetectedLockfile | null> {
    const candidates: Array<{ kind: LockfileKind; packageManager: 'pnpm' | 'npm' | 'yarn' }> = [
        { kind: 'pnpm-lock.yaml', packageManager: 'pnpm' },
        { kind: 'package-lock.json', packageManager: 'npm' },
        { kind: 'yarn.lock', packageManager: 'yarn' }
    ]
    for (const c of candidates) {
        const absolutePath = join(projectPath, c.kind)
        const exists = await fileExists(absolutePath)
        if (exists) {
            return { kind: c.kind, packageManager: c.packageManager, absolutePath }
        }
    }
    return null
}

async function readNvmrc(projectPath: string): Promise<string | null> {
    const p = join(projectPath, '.nvmrc')
    const exists = await fileExists(p)
    if (!exists) return null
    try {
        const text = await readFile(p, 'utf8')
        return text.trim() || null
    } catch {
        return null
    }
}

function ambientNodeMatches(nvmrcVersion: string): boolean {
    const want = nvmrcVersion.replace(/^v/i, '').trim()
    const have = process.version.replace(/^v/i, '').trim()
    if (!want || !have) return false
    return want === have
}

type SpawnState = {
    stdout: string
    stderr: string
    timedOut: boolean
    spawnError: Error | null
    settled: boolean
}

type SpawnFinalizeContext = {
    state: SpawnState
    timer: NodeJS.Timeout
    abortSignal: AbortSignal | undefined
    abortHandler: () => void
    resolve: (result: SpawnResult) => void
}

function finalizeSpawn(ctx: SpawnFinalizeContext, exitCode: number | null): void {
    if (ctx.state.settled) return
    ctx.state.settled = true
    clearTimeout(ctx.timer)
    if (ctx.abortSignal) {
        ctx.abortSignal.removeEventListener('abort', ctx.abortHandler)
    }
    ctx.resolve({
        stdout: ctx.state.stdout,
        stderr: ctx.state.stderr,
        exitCode,
        timedOut: ctx.state.timedOut,
        spawnError: ctx.state.spawnError
    })
}

function onSpawnTimeout(state: SpawnState, child: ChildProcess): void {
    state.timedOut = true
    try {
        child.kill('SIGKILL')
    } catch {
        // ignore
    }
}

function onSpawnAbort(child: ChildProcess): void {
    try {
        child.kill('SIGKILL')
    } catch {
        // ignore
    }
}

function onSpawnStdoutData(state: SpawnState, chunk: Buffer): void {
    state.stdout += chunk.toString('utf8')
}

function onSpawnStderrData(state: SpawnState, chunk: Buffer): void {
    state.stderr += chunk.toString('utf8')
}

function onSpawnError(ctx: SpawnFinalizeContext, err: Error): void {
    ctx.state.spawnError = err
    finalizeSpawn(ctx, null)
}

function onSpawnClose(ctx: SpawnFinalizeContext, code: number | null): void {
    finalizeSpawn(ctx, code)
}

// The one seam this scanner needs. `spawn` is otherwise a static ESM import called from inside a
// private function, which leaves the entire result-shaping surface below — timeout, ENOENT
// classification, nvm-wrapper failures, the three audit output schemas — unreachable without actually
// running a package manager. Injecting it mirrors createOsvScanner({ lookup, isSeeded, isEnabled }) in
// ./osv.ts, and defaults to the real thing so no caller changes.
export type NpmAuditDeps = {
    spawn: typeof spawn
}

const REAL_DEPS: NpmAuditDeps = { spawn }

type SpawnExecutorInput = {
    deps: NpmAuditDeps
    cmd: string
    args: string[]
    opts: { cwd: string; timeoutMs: number; abortSignal?: AbortSignal; stdin?: string }
}

function executeSpawnAndCapture(input: SpawnExecutorInput, resolve: (result: SpawnResult) => void): void {
    const state: SpawnState = {
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: null,
        settled: false
    }
    const child = input.deps.spawn(input.cmd, input.args, {
        cwd: input.opts.cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env
    })
    const ctx: SpawnFinalizeContext = {
        state,
        timer: setTimeout(onSpawnTimeout.bind(null, state, child), input.opts.timeoutMs),
        abortSignal: input.opts.abortSignal,
        abortHandler: onSpawnAbort.bind(null, child),
        resolve
    }
    if (input.opts.abortSignal) {
        input.opts.abortSignal.addEventListener('abort', ctx.abortHandler, { once: true })
    }
    child.stdout.on('data', onSpawnStdoutData.bind(null, state))
    child.stderr.on('data', onSpawnStderrData.bind(null, state))
    child.on('error', onSpawnError.bind(null, ctx))
    child.on('close', onSpawnClose.bind(null, ctx))
    if (input.opts.stdin && child.stdin) {
        child.stdin.end(input.opts.stdin)
    }
}

function spawnAndCapture(
    deps: NpmAuditDeps,
    cmd: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; abortSignal?: AbortSignal; stdin?: string }
): Promise<SpawnResult> {
    return new Promise(executeSpawnAndCapture.bind(null, { deps, cmd, args, opts }))
}

async function detectYarnMajor(projectPath: string, lockfile: DetectedLockfile): Promise<number | null> {
    try {
        const text = await readFile(join(projectPath, 'package.json'), 'utf8')
        const parsed = JSON.parse(text) as { packageManager?: unknown }
        const major = parseYarnMajor(parsed.packageManager)
        if (major !== null) return major
    } catch {
        // Fall back to lockfile markers.
    }
    try {
        const text = await readFile(lockfile.absolutePath, 'utf8')
        const firstLine = text.split('\n')[0] || ''
        if (/^# yarn lockfile v1/i.test(firstLine)) return 1
        if (/^__metadata:/m.test(text)) return 2
    } catch {
        return null
    }
    return null
}

// Emits a single stderr line per scan when the lockfile cross-check actually dropped findings.
// Silent when zero drops, so quiet scans stay quiet. The advisory-id list is truncated to keep
// the line readable even when an override cascades through a large dep graph.
function logCrossCheckDrops(result: { droppedCount: number; droppedAdvisoryIds: string[] }, packageManager: string): void {
    if (result.droppedCount === 0) return
    const MAX_LIST = 10
    const head = result.droppedAdvisoryIds.slice(0, MAX_LIST)
    const tail = result.droppedAdvisoryIds.length > MAX_LIST ? `, +${result.droppedAdvisoryIds.length - MAX_LIST} more` : ''
    process.stderr.write(`[${SCANNER_NAME}] lockfile cross-check (${packageManager}): dropped ${result.droppedCount} finding(s) out of vulnerable range [${head.join(', ')}${tail}]\n`)
}

export async function runNpmAudit(projectPath: string, ctx: ScanContext, deps: NpmAuditDeps = REAL_DEPS): Promise<ScanResult> {
    const startedAt = Date.now()
    const lockfile = await detectLockfile(projectPath)
    if (!lockfile) {
        return unauditableResult('no_lockfile', 'no lockfile', startedAt, '')
    }

    if (lockfile.packageManager === 'yarn') {
        const yarnMajor = await detectYarnMajor(projectPath, lockfile)
        if (yarnMajor === null) {
            return unauditableResult('unknown_pm', 'unable to determine Yarn major from packageManager or yarn.lock', startedAt, '')
        }
        if (yarnMajor < 2) {
            return unauditableResult('yarn_v1_unsupported', 'unsupported yarn version (yarn 1.x audit format incompatible)', startedAt, '')
        }
    }

    const useNvm = ctx.useNvm !== false
    let nvmrcVersion: string | null = null
    if (useNvm) {
        nvmrcVersion = await readNvmrc(projectPath)
    }
    const wrapWithNvm = nvmrcVersion !== null && !ambientNodeMatches(nvmrcVersion)

    const rawCmd = pickAuditCommand(lockfile)
    let execCmd: string
    let execArgs: string[]
    if (wrapWithNvm) {
        const wrapped = buildBashWrappedCommand(rawCmd)
        execCmd = wrapped.cmd
        execArgs = wrapped.args
    } else {
        const parts = rawCmd.split(' ')
        const head = parts[0]
        if (!head) {
            return errorResult('audit_unknown_failure', 'failed to construct audit command', startedAt, '')
        }
        execCmd = head
        execArgs = parts.slice(1)
    }

    const spawnResult = await spawnAndCapture(deps, execCmd, execArgs, {
        cwd: projectPath,
        timeoutMs: ctx.timeoutMs,
        abortSignal: ctx.abortSignal
    })

    if (spawnResult.timedOut) {
        return timeoutResult(ctx.timeoutMs, startedAt, spawnResult.stdout)
    }
    if (spawnResult.spawnError) {
        const msg = spawnResult.spawnError.message || 'spawn failed'
        if (msg.includes('ENOENT')) {
            if (wrapWithNvm) {
                return errorResult('bash_missing', 'bash not on PATH (required for nvm-aware scans)', startedAt, '')
            }
            const tool = lockfile.packageManager
            return unauditableResult('pm_missing', `${tool} not on PATH`, startedAt, '')
        }
        return errorResult('audit_spawn_error', `spawn error: ${msg}`, startedAt, '')
    }

    const rawText = spawnResult.stdout
    if (wrapWithNvm && spawnResult.exitCode !== 0 && !rawText.trim()) {
        const nvmFailure = classifyNvmWrapperFailure(spawnResult.stderr)
        if (nvmFailure) {
            if (nvmFailure.kind === 'unauditable') {
                return unauditableResult(nvmFailure.reasonCode, nvmFailure.reason, startedAt, '')
            }
            return errorResult(nvmFailure.reasonCode, nvmFailure.reason, startedAt, '')
        }
        if (classifyPackageManagerNotFound(spawnResult.stderr, lockfile.packageManager)) {
            return unauditableResult('pm_missing', `${lockfile.packageManager} not on PATH (after nvm install)`, startedAt, '')
        }
        const stderrTrim = spawnResult.stderr.trim()
        const firstLine = stderrTrim.split('\n')[0] || 'unknown failure'
        return errorResult('audit_unknown_failure', `wrapped audit command failed: ${firstLine.slice(0, 200)}`, startedAt, '')
    }
    if (!rawText.trim()) {
        const stderrTrim = spawnResult.stderr.trim()
        const reason = stderrTrim || 'empty audit output'
        return errorResult('audit_empty_output', reason, startedAt, '')
    }

    let parsedJson: unknown
    try {
        parsedJson = JSON.parse(rawText)
    } catch (err) {
        let reason = 'audit JSON parse failed'
        if (err instanceof Error) {
            reason = `audit JSON parse failed: ${err.message}`
        }
        return errorResult('audit_parse_error', reason, startedAt, rawText)
    }

    // pnpm emits {actions, advisories} — looks superficially like legacy npm 6, but is the *current*
    // pnpm format. Parse it with the pnpm schema; do NOT run looksLikeLegacyShape() for pnpm.
    if (lockfile.packageManager === 'pnpm') {
        const pnpmValidation = pnpmAuditSchema.safeParse(parsedJson)
        if (!pnpmValidation.success) {
            return errorResult('audit_schema_mismatch', `pnpm audit JSON schema mismatch: ${pnpmValidation.error.message.slice(0, 400)}`, startedAt, rawText)
        }
        const pnpmClassifier = await buildDepClassifier(projectPath, ctx.resolvedGraph || null)
        const rawFindings = normalizePnpmAuditOutput(pnpmValidation.data, pnpmClassifier)
        const crossChecked = filterFindingsByLockfileResolution(rawFindings)
        logCrossCheckDrops(crossChecked, lockfile.packageManager)
        return {
            status: 'ok',
            reasonCode: 'ok',
            findings: crossChecked.kept,
            rawJson: rawText,
            errorText: null,
            durationMs: Date.now() - startedAt
        }
    }

    // npm / yarn-berry path: modern `{vulnerabilities}` shape only. Reject true npm 6 legacy.
    if (lockfile.packageManager === 'npm' && looksLikeLegacyShape(rawText)) {
        return errorResult('legacy_npm6_format', 'legacy npm-audit JSON shape (npm 6) is not supported', startedAt, rawText)
    }

    const validation = modernAuditSchema.safeParse(parsedJson)
    if (!validation.success) {
        return errorResult('audit_schema_mismatch', `audit JSON schema mismatch: ${validation.error.message.slice(0, 400)}`, startedAt, rawText)
    }

    const snapshot = await loadLockfileSnapshot(projectPath, lockfile)
    const classifier = await buildDepClassifier(projectPath, ctx.resolvedGraph || null)
    const { findings, hadVulnerabilityWithoutConcreteAdvisory } = normalizeAuditOutput(validation.data, snapshot.installedVersions, classifier)
    if (hadVulnerabilityWithoutConcreteAdvisory && findings.length === 0) {
        return errorResult('audit_no_advisories', 'npm-audit output had no concrete advisory objects', startedAt, rawText)
    }

    const crossChecked = filterFindingsByLockfileResolution(findings)
    logCrossCheckDrops(crossChecked, lockfile.packageManager)

    return {
        status: 'ok',
        reasonCode: 'ok',
        findings: crossChecked.kept,
        rawJson: rawText,
        errorText: null,
        durationMs: Date.now() - startedAt
    }
}

// Binds a deps object into a plugin, the same shape createOsvScanner returns. The production plugin
// below is this with the real spawn; a test builds one with a fake and drives the whole
// result-shaping surface without a package manager on PATH.
export function createNpmAuditScanner(deps: NpmAuditDeps): ScannerPlugin {
    return {
        name: SCANNER_NAME,
        scan: function scan(projectPath: string, ctx: ScanContext): Promise<ScanResult> {
            return runNpmAudit(projectPath, ctx, deps)
        }
    }
}

export const npmAuditPlugin: ScannerPlugin = createNpmAuditScanner(REAL_DEPS)
