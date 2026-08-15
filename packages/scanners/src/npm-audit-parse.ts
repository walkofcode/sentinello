import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Severity, ReasonCode } from '@sentinello/core'
import type { DetectedLockfile, RawFinding, ScanResult } from './types'
import { pickSafeFixVersion } from './version-fix'

// The pure half of the npm-audit scanner: every schema for the JSON shapes the three package
// managers emit, plus the normalization and stderr-classification logic that turns those shapes into
// findings and reason codes.
//
// Split out of npm-audit.ts so the decisions that matter — which advisory id wins, what severity a
// finding gets, why a scan came back unauditable — are reachable without spawning a package manager.
// npm-audit.ts keeps the process spawning, the nvm wrapper and the filesystem reads; nothing here
// touches the network, the filesystem or a child process.

const SEVERITY_VALUES = ['critical', 'high', 'moderate', 'low', 'info'] as const

// Lenient on purpose. This schema is applied inside a whole-document safeParse, so a closed enum meant
// that ONE advisory carrying a grade npm had not used before failed the parse for the entire project —
// every finding in it discarded and the scan reported unauditable, because of a single word. Falling
// back to 'moderate' matches the policy core's severityWeight and the matcher's mapSeverity already
// state for an unrecognised grade: never downgrade something we could not read.
//
// Only the severity leaf is lenient. The surrounding object shapes stay strict, which is what
// audit_schema_mismatch exists to catch.
const severitySchema = z.enum(SEVERITY_VALUES).catch('moderate')

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

export type ViaObject = z.infer<typeof viaObjectSchema>

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

export type FixAvailable = z.infer<typeof fixAvailableSchema>

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

export type Vulnerability = z.infer<typeof vulnerabilitySchema>

export const modernAuditSchema = z
    .object({
        auditReportVersion: z.number().int().optional(),
        vulnerabilities: z.record(z.string(), vulnerabilitySchema).optional(),
        metadata: z.object({}).passthrough().optional()
    })
    .passthrough()

export type ModernAudit = z.infer<typeof modernAuditSchema>

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

export type PnpmAdvisory = z.infer<typeof pnpmAdvisorySchema>

export const pnpmAuditSchema = z
    .object({
        actions: z.array(z.unknown()).optional(),
        advisories: z.record(z.string(), pnpmAdvisorySchema).optional(),
        metadata: z.object({}).passthrough().optional()
    })
    .passthrough()

export type PnpmAudit = z.infer<typeof pnpmAuditSchema>

// Subset of npm v7+ package-lock.json we care about: the `packages` map keyed by node path
// (e.g. "node_modules/lodash" or "" for the project root). Modern `npm audit --json` doesn't
// emit the installed version directly — it only gives us `vuln.nodes[]` (those same node paths).
// We read the lockfile and resolve each node path to its concrete installed version so the UI
// shows the actual installed version instead of the vulnerable range. The `dev` flag on each
// entry is also captured to drive prod/dev classification.
export const packageLockSchema = z
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

export type InstalledVersionMap = Map<string, string>

export type DepClassifier = {
    classify(packageName: string, version: string | null): { isProd: boolean; isDev: boolean }
}

const GHSA_URL_RE = /\/advisories\/(GHSA-[a-z0-9-]+)/i

export function buildBashWrappedCommand(rawCmd: string): { cmd: string; args: string[] } {
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

export type NvmFailure = { kind: 'unauditable' | 'error'; reasonCode: ReasonCode; reason: string }

export function classifyNvmWrapperFailure(stderr: string): NvmFailure | null {
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

export function classifyPackageManagerNotFound(stderr: string, packageManager: string): boolean {
    const escaped = packageManager.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re1 = new RegExp(`(?:^|[^a-z])${escaped}: command not found`, 'i')
    const re2 = new RegExp(`command not found:\\s*${escaped}(?:\\b|$)`, 'i')
    return re1.test(stderr) || re2.test(stderr)
}

export function pickAuditCommand(lockfile: DetectedLockfile): string {
    if (lockfile.packageManager === 'pnpm') return 'pnpm audit --json'
    if (lockfile.packageManager === 'npm') return 'npm audit --json'
    return 'yarn npm audit --json'
}

export function parseYarnMajor(value: unknown): number | null {
    if (typeof value !== 'string') return null
    const match = value.trim().match(/^yarn@(\d+)(?:\.|$)/)
    if (!match || !match[1]) return null
    const parsed = parseInt(match[1], 10)
    if (Number.isNaN(parsed)) return null
    return parsed
}

export function unauditableResult(reasonCode: ReasonCode, reason: string, startedAt: number, rawJson: string): ScanResult {
    return {
        status: 'unauditable',
        reasonCode,
        findings: [],
        rawJson,
        errorText: reason,
        durationMs: Date.now() - startedAt
    }
}

export function errorResult(reasonCode: ReasonCode, reason: string, startedAt: number, rawJson: string): ScanResult {
    return {
        status: 'error',
        reasonCode,
        findings: [],
        rawJson,
        errorText: reason,
        durationMs: Date.now() - startedAt
    }
}

export function timeoutResult(timeoutMs: number, startedAt: number, rawJson: string): ScanResult {
    return {
        status: 'timeout',
        reasonCode: 'timeout',
        findings: [],
        rawJson,
        errorText: `timeout after ${timeoutMs}ms`,
        durationMs: Date.now() - startedAt
    }
}

export function isViaObject(via: string | ViaObject): via is ViaObject {
    return typeof via !== 'string'
}

export function pickGhsaIdFromUrl(url: string | undefined): string | null {
    if (!url) return null
    const match = url.match(GHSA_URL_RE)
    if (!match || !match[1]) return null
    return match[1]
}

export function fallbackAdvisoryHash(via: ViaObject): string {
    const parts = [String(via.source ?? ''), String(via.url ?? ''), String(via.title ?? '')]
    const digest = createHash('sha256').update(parts.join('|')).digest('hex')
    return `npmaudit-hash-${digest.slice(0, 16)}`
}

export function pickAdvisoryId(via: ViaObject): string | null {
    if (typeof via.source === 'number' && Number.isFinite(via.source)) {
        return String(via.source)
    }
    const ghsa = pickGhsaIdFromUrl(via.url)
    if (ghsa) return ghsa
    if (via.source == null && !via.url && !via.title) return null
    return fallbackAdvisoryHash(via)
}

// The GHSA id npm hands us alongside its own numeric one, kept as a cross-reference alias.
//
// pickAdvisoryId deliberately still prefers the numeric id: it is what findings, mutes and
// notification events have been keyed by since long before a GHSA was read out of the URL, and
// changing it would orphan every mute an operator has ever written. But that id is npm's alone. OSV
// and gemnasium key the same advisory by GHSA or CVE, so an identity built only from the numeric id
// could never intersect theirs — findingIdentityKeys compared ["1093507"] against
// ["ghsa-7px7-7xjx-hxm8", "cve-…"] and found nothing in common. Cross-source dedup therefore never
// fired for an npm-audit finding even once: the same advisory was stored twice, counted twice on
// every raw-row surface, notified twice, and the corroboration badge that exists to show two sources
// agreeing could not appear on the one pairing it was written for.
//
// The GHSA was in hand the whole time, in the advisory URL npm already gives us.
export function pickAdvisoryAliases(advisoryId: string, url: string | undefined, githubAdvisoryId?: string | null): string[] {
    // pnpm names the GHSA outright; npm and yarn only carry it inside the advisory URL. An empty
    // string is not a GHSA, so falling through to the URL is the right reading of one.
    const explicit = typeof githubAdvisoryId === 'string' && githubAdvisoryId.length > 0 && githubAdvisoryId
    const ghsa = explicit || pickGhsaIdFromUrl(url)
    if (!ghsa) return []
    // Already the primary id (npm omitted its numeric one), so it is not an alias of itself.
    if (ghsa.toLowerCase() === advisoryId.toLowerCase()) return []
    return [ghsa]
}

// The fallback is 'moderate', not 'info'. npm reported a vulnerability here; the only thing missing is
// how bad it is. Grading that 'info' is a downgrade Sentinello invented, and it hides the finding from
// every operator whose minimum-severity filter sits above the floor — the quietest way to lose a real
// advisory. Same policy as core's severityWeight and the matcher's mapSeverity.
export function pickSeverity(via: ViaObject, vuln: Vulnerability): Severity {
    if (via.severity) return via.severity
    if (vuln.severity) return vuln.severity
    return 'moderate'
}

export function pickFixAvailability(fix: FixAvailable | undefined): { fixAvailable: boolean; fixVersion: string | null } {
    if (fix === undefined) return { fixAvailable: false, fixVersion: null }
    if (fix === true) return { fixAvailable: true, fixVersion: null }
    if (fix === false) return { fixAvailable: false, fixVersion: null }
    return { fixAvailable: true, fixVersion: fix.version || null }
}

export function pickVulnerableRange(via: ViaObject, vuln: Vulnerability): string {
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
export function pickInstalledVersion(vuln: Vulnerability, installedVersions: InstalledVersionMap): string {
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

export function pickDepPath(vuln: Vulnerability): string[] {
    if (!vuln.nodes || vuln.nodes.length === 0) return []
    const out: string[] = []
    for (const node of vuln.nodes) {
        out.push(node)
    }
    return out
}

export function normalizeOneVulnerability(vuln: Vulnerability, packageName: string, installedVersions: InstalledVersionMap, classifier: DepClassifier): { findings: RawFinding[]; hasConcreteAdvisory: boolean } {
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
            aliases: pickAdvisoryAliases(advisoryId, via.url),
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

export function normalizeAuditOutput(parsed: ModernAudit, installedVersions: InstalledVersionMap, classifier: DepClassifier): { findings: RawFinding[]; hadVulnerabilityWithoutConcreteAdvisory: boolean } {
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

export function pickPnpmAdvisoryId(adv: PnpmAdvisory, numericIdKey: string): string {
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

export function normalizePnpmAuditOutput(parsed: PnpmAudit, classifier: DepClassifier): RawFinding[] {
    const out: RawFinding[] = []
    const advisories = parsed.advisories ?? {}
    for (const idKey of Object.keys(advisories)) {
        const adv = advisories[idKey]
        if (!adv) continue
        const advisoryId = pickPnpmAdvisoryId(adv, idKey)
        // 'moderate' rather than 'info' for the same reason as pickSeverity: a graded-less advisory is
        // an unknown, not a harmless one.
        const severity: Severity = adv.severity || 'moderate'
        const patched = adv.patched_versions || null
        const recommendation = adv.recommendation || null
        const vulnRange = adv.vulnerable_versions || ''
        const advisoryTitle = adv.title || null
        const advisoryUrl = adv.url || null
        // pnpm names the GHSA outright rather than only in the URL, so prefer the explicit field.
        const aliases = pickAdvisoryAliases(advisoryId, adv.url ?? undefined, adv.github_advisory_id)
        const packageName = adv.module_name
        const findings = adv.findings || []
        if (findings.length === 0) {
            const fixVersion = pickSafeFixVersion({ patched, recommendation, vulnerable: vulnRange, installed: null })
            const cls = classifier.classify(packageName, null)
            out.push({
                advisoryId,
                aliases,
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
                    aliases,
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
                    aliases,
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

export function looksLikeLegacyShape(rawText: string): boolean {
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
