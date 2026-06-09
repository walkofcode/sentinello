import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Severity, ReasonCode } from '@sentinello/core'
import type {
    DetectedLockfile,
    LockfileKind,
    RawFinding,
    ScanContext,
    ScannerPlugin,
    ScanResult
} from './types'
import { pickSafeFixVersion } from './version-fix'
import { filterFindingsByLockfileResolution } from './lockfile-cross-check'
import type { ResolvedGraph } from './resolver'

const SCANNER_NAME = 'npm-audit'

const SEVERITY_VALUES = ['critical', 'high', 'moderate', 'low', 'info'] as const

const severitySchema = z.enum(SEVERITY_VALUES)

const viaObjectSchema = z
    .object({
        source: z.number().int().optional(),
        name: z.string().optional(),
        dependency: z.string().optional(),
        title: z.string().optional(),
        url: z.string().optional(),
        severity: severitySchema.optional(),
        range: z.string().optional()
    })
    .passthrough()

type ViaObject = z.infer<typeof viaObjectSchema>

const viaSchema = z.union([z.string(), viaObjectSchema])

const fixAvailableSchema = z.union([
    z.boolean(),
    z
        .object({
            name: z.string(),
            version: z.string(),
            isSemVerMajor: z.boolean()
        })
        .passthrough()
])

type FixAvailable = z.infer<typeof fixAvailableSchema>

const vulnerabilitySchema = z
    .object({
        name: z.string(),
        severity: severitySchema.optional(),
        isDirect: z.boolean().optional(),
        via: z.array(viaSchema),
        effects: z.array(z.string()).optional(),
        range: z.string().optional(),
        nodes: z.array(z.string()).optional(),
        fixAvailable: fixAvailableSchema.optional()
    })
    .passthrough()

type Vulnerability = z.infer<typeof vulnerabilitySchema>

const modernAuditSchema = z
    .object({
        auditReportVersion: z.number().int().optional(),
        vulnerabilities: z.record(z.string(), vulnerabilitySchema).optional(),
        metadata: z.object({}).passthrough().optional()
    })
    .passthrough()

const legacyAuditSchema = z
    .object({
        actions: z.array(z.unknown()).optional(),
        advisories: z.record(z.string(), z.unknown()).optional()
    })
    .passthrough()

// pnpm audit --json envelope. Looks superficially like legacy npm 6 (also uses `advisories` keyed
// by numeric id), but pnpm emits this for *every* modern pnpm version (8+). Distinguished from
// legacy by the absence of npm-6-specific top-level fields and presence of pnpm-style finding shape.
const pnpmAdvisoryFindingSchema = z
    .object({
        version: z.string().optional(),
        paths: z.array(z.string()).optional()
    })
    .passthrough()

const pnpmAdvisorySchema = z
    .object({
        id: z.number().int().optional(),
        github_advisory_id: z.string().optional().nullable(),
        npm_advisory_id: z.union([z.number(), z.string()]).optional().nullable(),
        url: z.string().optional().nullable(),
        title: z.string().optional().nullable(),
        severity: severitySchema.optional(),
        module_name: z.string(),
        vulnerable_versions: z.string().optional().nullable(),
        patched_versions: z.string().optional().nullable(),
        recommendation: z.string().optional().nullable(),
        findings: z.array(pnpmAdvisoryFindingSchema).optional()
    })
    .passthrough()

type PnpmAdvisory = z.infer<typeof pnpmAdvisorySchema>

const pnpmAuditSchema = z
    .object({
        actions: z.array(z.unknown()).optional(),
        advisories: z.record(z.string(), pnpmAdvisorySchema).optional(),
        metadata: z.object({}).passthrough().optional()
    })
    .passthrough()

// Subset of npm v7+ package-lock.json we care about: the `packages` map keyed by node path
// (e.g. "node_modules/lodash" or "" for the project root). Modern `npm audit --json` doesn't
// emit the installed version directly — it only gives us `vuln.nodes[]` (those same node paths).
// We read the lockfile and resolve each node path to its concrete installed version so the UI
// shows the actual installed version instead of the vulnerable range. The `dev` flag on each
// entry is also captured to drive prod/dev classification.
const packageLockSchema = z
    .object({
        lockfileVersion: z.number().int().optional(),
        packages: z
            .record(
                z.string(),
                z
                    .object({
                        version: z.string().optional(),
                        dev: z.boolean().optional(),
                        devOptional: z.boolean().optional()
                    })
                    .passthrough()
            )
            .optional()
    })
    .passthrough()

type InstalledVersionMap = Map<string, string>

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
type DepClassifier = {
    classify(packageName: string, version: string | null): { isProd: boolean; isDev: boolean }
}

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

const GHSA_URL_RE = /\/advisories\/(GHSA-[a-z0-9-]+)/i

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

type SpawnExecutorInput = {
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
    const child = spawn(input.cmd, input.args, {
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
    cmd: string,
    args: string[],
    opts: { cwd: string; timeoutMs: number; abortSignal?: AbortSignal; stdin?: string }
): Promise<SpawnResult> {
    return new Promise(executeSpawnAndCapture.bind(null, { cmd, args, opts }))
}

function buildBashWrappedCommand(rawCmd: string): { cmd: string; args: string[] } {
    // `nvm install` (no version arg) reads the project's .nvmrc, installs that Node version if it
    // is not already present, then activates it — so a scan no longer fails just because the host
    // image lacks the requested version. It is idempotent: an already-installed version is reused
    // without re-downloading. Installed versions live under $NVM_DIR; persist /root/.nvm across
    // container restarts so the download happens only once.
    //
    // `nvm install` prints its progress ("Found '.nvmrc'…", "Downloading…", "Now using…") to
    // STDOUT, which would otherwise prepend non-JSON noise to the audit output and break parsing.
    // Redirect that chatter to stderr (1>&2) so stdout carries only the audit JSON; nvm failures
    // are still classified from stderr.
    return {
        cmd: 'bash',
        args: ['-lc', `source ~/.nvm/nvm.sh && nvm install 1>&2 && ${rawCmd}`]
    }
}

type NvmFailure = { kind: 'unauditable' | 'error'; reasonCode: ReasonCode; reason: string }

function classifyNvmWrapperFailure(stderr: string): NvmFailure | null {
    if (/nvm\.sh[^:]*:.*no such file/i.test(stderr)) {
        return { kind: 'unauditable', reasonCode: 'nvm_missing', reason: 'nvm not on PATH' }
    }
    if (/no such file or directory/i.test(stderr) && /\.nvm\/nvm\.sh/i.test(stderr)) {
        return { kind: 'unauditable', reasonCode: 'nvm_missing', reason: 'nvm not on PATH' }
    }
    if (/(?:^|[^a-z])nvm: command not found/i.test(stderr)) {
        return { kind: 'unauditable', reasonCode: 'nvm_missing', reason: 'nvm not on PATH' }
    }
    if (/command not found:\s*nvm(?:\b|$)/i.test(stderr)) {
        return { kind: 'unauditable', reasonCode: 'nvm_missing', reason: 'nvm not on PATH' }
    }
    // `nvm install` could not obtain the .nvmrc version: the version does not exist upstream
    // (e.g. an unreleased major) or the download/checksum step failed (network, mirror).
    if (/version ["']?v?[\d.]+["']? not found/i.test(stderr) || /not found - try/i.test(stderr)) {
        return { kind: 'error', reasonCode: 'nvm_install_failed', reason: 'nvm install failed: requested Node version not found upstream' }
    }
    if (/(?:binary download failed|checksum check failed|failed to download|downloading .* failed)/i.test(stderr)) {
        return { kind: 'error', reasonCode: 'nvm_install_failed', reason: 'nvm install failed: Node download failed' }
    }
    // With `nvm install` an "is not yet installed" / "N/A" message means the install did not take.
    if (/is not yet installed/i.test(stderr)) {
        return { kind: 'error', reasonCode: 'nvm_install_failed', reason: 'nvm install failed: requested Node version not installed' }
    }
    if (/n\/a:/i.test(stderr) && /nvm/i.test(stderr)) {
        return { kind: 'error', reasonCode: 'nvm_install_failed', reason: 'nvm install failed' }
    }
    return null
}

function classifyPackageManagerNotFound(stderr: string, packageManager: string): boolean {
    const escaped = packageManager.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re1 = new RegExp(`(?:^|[^a-z])${escaped}: command not found`, 'i')
    const re2 = new RegExp(`command not found:\\s*${escaped}(?:\\b|$)`, 'i')
    return re1.test(stderr) || re2.test(stderr)
}

function pickAuditCommand(lockfile: DetectedLockfile): string {
    if (lockfile.packageManager === 'pnpm') return 'pnpm audit --json'
    if (lockfile.packageManager === 'npm') return 'npm audit --json'
    return 'yarn npm audit --json'
}

function parseYarnMajor(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const match = value.trim().match(/^yarn@(\d+)(?:\.|$)/)
    if (!match || !match[1]) return null
    const parsed = parseInt(match[1], 10)
    if (Number.isNaN(parsed)) return null
    return parsed
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

function unauditableResult(reasonCode: ReasonCode, reason: string, startedAt: number, rawJson: string): ScanResult {
    return {
        status: 'unauditable',
        reasonCode,
        findings: [],
        rawJson,
        errorText: reason,
        durationMs: Date.now() - startedAt
    }
}

function errorResult(reasonCode: ReasonCode, reason: string, startedAt: number, rawJson: string): ScanResult {
    return {
        status: 'error',
        reasonCode,
        findings: [],
        rawJson,
        errorText: reason,
        durationMs: Date.now() - startedAt
    }
}

function timeoutResult(timeoutMs: number, startedAt: number, rawJson: string): ScanResult {
    return {
        status: 'timeout',
        reasonCode: 'timeout',
        findings: [],
        rawJson,
        errorText: `timeout after ${timeoutMs}ms`,
        durationMs: Date.now() - startedAt
    }
}

function isViaObject(via: string | ViaObject): via is ViaObject {
    return typeof via !== 'string'
}

function pickGhsaIdFromUrl(url: string | undefined): string | null {
    if (!url) return null
    const match = url.match(GHSA_URL_RE)
    if (!match || !match[1]) return null
    return match[1]
}

function fallbackAdvisoryHash(via: ViaObject): string {
    const parts = [String(via.source ?? ''), String(via.url ?? ''), String(via.title ?? '')]
    const digest = createHash('sha256').update(parts.join('|')).digest('hex')
    return `npmaudit-hash-${digest.slice(0, 16)}`
}

function pickAdvisoryId(via: ViaObject): string | null {
    if (typeof via.source === 'number' && Number.isFinite(via.source)) {
        return String(via.source)
    }
    const ghsa = pickGhsaIdFromUrl(via.url)
    if (ghsa) return ghsa
    if (via.source == null && !via.url && !via.title) return null
    return fallbackAdvisoryHash(via)
}

function pickSeverity(via: ViaObject, vuln: Vulnerability): Severity {
    if (via.severity) return via.severity
    if (vuln.severity) return vuln.severity
    return 'info'
}

function pickFixAvailability(fix: FixAvailable | undefined): { fixAvailable: boolean; fixVersion: string | null } {
    if (fix === undefined) return { fixAvailable: false, fixVersion: null }
    if (fix === true) return { fixAvailable: true, fixVersion: null }
    if (fix === false) return { fixAvailable: false, fixVersion: null }
    return { fixAvailable: true, fixVersion: fix.version || null }
}

function pickVulnerableRange(via: ViaObject, vuln: Vulnerability): string {
    if (via.range) return via.range
    if (vuln.range) return vuln.range
    return ''
}

// Resolves the actual installed version for a vulnerability by mapping its `nodes[]` paths
// (e.g. "node_modules/lodash") through the lockfile-derived version map. When `vuln.nodes`
// resolves to multiple distinct versions (npm hoisting can leave duplicate copies at
// different versions), join the unique values so the UI can show e.g. "4.0.0, 4.5.0".
// Falls back to `vuln.range` only when no lookup is possible, which preserves prior behavior
// for projects without a parseable package-lock.json (yarn.lock today, malformed locks, etc.).
function pickInstalledVersion(vuln: Vulnerability, installedVersions: InstalledVersionMap): string {
    const nodes = vuln.nodes || []
    if (nodes.length > 0 && installedVersions.size > 0) {
        const resolved = new Set<string>()
        for (const node of nodes) {
            const v = installedVersions.get(node)
            if (v) resolved.add(v)
        }
        if (resolved.size > 0) {
            return Array.from(resolved).join(', ')
        }
    }
    if (vuln.range) return vuln.range
    return ''
}

function pickDepPath(vuln: Vulnerability): string[] {
    if (!vuln.nodes || vuln.nodes.length === 0) return []
    const out: string[] = []
    for (const node of vuln.nodes) {
        out.push(node)
    }
    return out
}

function normalizeOneVulnerability(vuln: Vulnerability, packageName: string, installedVersions: InstalledVersionMap, classifier: DepClassifier): { findings: RawFinding[]; hasConcreteAdvisory: boolean } {
    const findings: RawFinding[] = []
    for (const via of vuln.via) {
        if (!isViaObject(via)) {
            continue
        }
        const advisoryId = pickAdvisoryId(via)
        if (!advisoryId) {
            continue
        }
        const installedVersion = pickInstalledVersion(vuln, installedVersions)
        const vulnerableRange = pickVulnerableRange(via, vuln)
        const raw = pickFixAvailability(vuln.fixAvailable)
        // Always run the picker: it sanity-checks npm's recommendation when present, AND
        // derives a fix from the vulnerable range upper bound when npm didn't name one
        // (e.g. vuln <=5.2.1 implies 5.2.2 even if npm audit said "no fix available").
        const fixVersion = pickSafeFixVersion({ patched: null, recommendation: raw.fixVersion, vulnerable: vulnerableRange, installed: installedVersion })
        let fixAvailable = fixVersion !== null
        if (!fixAvailable && raw.fixAvailable && raw.fixVersion === null) {
            fixAvailable = true
        }
        const depPath = pickDepPath(vuln)
        const cls = classifier.classify(packageName, installedVersion)
        const finding: RawFinding = {
            advisoryId,
            advisoryTitle: via.title || null,
            advisoryUrl: via.url || null,
            packageName,
            installedVersion,
            vulnerableRange,
            severity: pickSeverity(via, vuln),
            fixAvailable,
            fixVersion,
            depPath,
            isProd: cls.isProd,
            isDev: cls.isDev
        }
        findings.push(finding)
    }
    return { findings, hasConcreteAdvisory: findings.length > 0 }
}

function normalizeAuditOutput(parsed: z.infer<typeof modernAuditSchema>, installedVersions: InstalledVersionMap, classifier: DepClassifier): { findings: RawFinding[]; hadVulnerabilityWithoutConcreteAdvisory: boolean } {
    const findings: RawFinding[] = []
    let hadVulnerabilityWithoutConcreteAdvisory = false
    const vulns = parsed.vulnerabilities ?? {}
    for (const packageName of Object.keys(vulns)) {
        const vuln = vulns[packageName]
        if (!vuln) continue
        if (!vuln.via || vuln.via.length === 0) {
            hadVulnerabilityWithoutConcreteAdvisory = true
            continue
        }
        const result = normalizeOneVulnerability(vuln, packageName, installedVersions, classifier)
        if (!result.hasConcreteAdvisory) {
            hadVulnerabilityWithoutConcreteAdvisory = true
            continue
        }
        for (const f of result.findings) {
            findings.push(f)
        }
    }
    return { findings, hadVulnerabilityWithoutConcreteAdvisory }
}

function pickPnpmAdvisoryId(adv: PnpmAdvisory, numericIdKey: string): string {
    if (adv.github_advisory_id && /^GHSA-/i.test(adv.github_advisory_id)) {
        return adv.github_advisory_id
    }
    const fromUrl = pickGhsaIdFromUrl(adv.url || undefined)
    if (fromUrl) return fromUrl
    if (typeof adv.id === 'number' && Number.isFinite(adv.id)) {
        return String(adv.id)
    }
    return `npmaudit-${numericIdKey}`
}

function normalizePnpmAuditOutput(parsed: z.infer<typeof pnpmAuditSchema>, classifier: DepClassifier): RawFinding[] {
    const out: RawFinding[] = []
    const advisories = parsed.advisories ?? {}
    for (const idKey of Object.keys(advisories)) {
        const adv = advisories[idKey]
        if (!adv) continue
        const advisoryId = pickPnpmAdvisoryId(adv, idKey)
        const severity: Severity = adv.severity || 'info'
        const patched = adv.patched_versions || null
        const recommendation = adv.recommendation || null
        const vulnRange = adv.vulnerable_versions || ''
        const advisoryTitle = adv.title || null
        const advisoryUrl = adv.url || null
        const packageName = adv.module_name
        const findings = adv.findings || []
        if (findings.length === 0) {
            const fixVersion = pickSafeFixVersion({ patched, recommendation, vulnerable: vulnRange, installed: null })
            const cls = classifier.classify(packageName, null)
            out.push({
                advisoryId,
                advisoryTitle,
                advisoryUrl,
                packageName,
                installedVersion: '',
                vulnerableRange: vulnRange,
                severity,
                fixAvailable: fixVersion !== null,
                fixVersion,
                depPath: [],
                isProd: cls.isProd,
                isDev: cls.isDev
            })
            continue
        }
        for (const f of findings) {
            const installed = f.version || null
            const fixVersion = pickSafeFixVersion({ patched, recommendation, vulnerable: vulnRange, installed })
            const fixAvailable = fixVersion !== null
            const paths = f.paths || []
            if (paths.length === 0) {
                const cls = classifier.classify(packageName, f.version || null)
                out.push({
                    advisoryId,
                    advisoryTitle,
                    advisoryUrl,
                    packageName,
                    installedVersion: f.version || '',
                    vulnerableRange: vulnRange,
                    severity,
                    fixAvailable,
                    fixVersion,
                    depPath: [],
                    isProd: cls.isProd,
                    isDev: cls.isDev
                })
                continue
            }
            for (const path of paths) {
                const depPath = path.split('>')
                const cls = classifier.classify(packageName, f.version || null)
                out.push({
                    advisoryId,
                    advisoryTitle,
                    advisoryUrl,
                    packageName,
                    installedVersion: f.version || '',
                    vulnerableRange: vulnRange,
                    severity,
                    fixAvailable,
                    fixVersion,
                    depPath,
                    isProd: cls.isProd,
                    isDev: cls.isDev
                })
            }
        }
    }
    return out
}

function looksLikeLegacyShape(rawText: string): boolean {
    const trimmed = rawText.trimStart()
    if (!trimmed.startsWith('{')) return false
    try {
        const parsed = JSON.parse(trimmed)
        const result = legacyAuditSchema.safeParse(parsed)
        if (!result.success) return false
        const data = result.data
        const hasLegacyActions = Array.isArray(data.actions)
        const hasLegacyAdvisories = data.advisories !== undefined
        const hasModern = (parsed as { vulnerabilities?: unknown }).vulnerabilities !== undefined
        return (hasLegacyActions || hasLegacyAdvisories) && !hasModern
    } catch {
        return false
    }
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

export async function runNpmAudit(projectPath: string, ctx: ScanContext): Promise<ScanResult> {
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

    const spawnResult = await spawnAndCapture(execCmd, execArgs, {
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

export const npmAuditPlugin: ScannerPlugin = {
    name: SCANNER_NAME,
    scan: runNpmAudit
}
