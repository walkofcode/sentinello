import type { EcosystemId } from './ecosystems'
import type { NotificationSourceScope } from './sources'

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info'

// One source independently reporting an advisory that another source already reported for the same
// package. The scan keeps ONE finding per vulnerability — reporting the same flaw three times because
// three databases know about it is noise, not information — but which sources agreed, and how each one
// graded it, is worth keeping: three databases concurring is a materially different fact from one.
//
// `advisoryId` is per-source on purpose. gemnasium frequently identifies a vulnerability that has no CVE
// under its own GMS-… id while npm-audit has a CVE for it, so the corroborating id is the one that makes
// that source's writeup findable, not a copy of the surviving finding's.
export type FindingCorroboration = {
    source: string
    advisoryId: string
    severity: Severity
}

// Reads a persisted corroboration column. Degrades rather than throws, and validates entry by entry:
// this is provenance, so a row whose column was corrupted — by a partial write, a hand-edited database,
// or a future writer with a different shape — is worth showing WITHOUT its badges. Letting JSON.parse
// escape would instead take down every query that touched the row, and with it the project page. A
// half-written object would otherwise reach the UI as an `undefined` source name.
export function parseFindingCorroborations(json: string): FindingCorroboration[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(json)
    } catch {
        return []
    }
    if (!Array.isArray(parsed)) return []
    const out: FindingCorroboration[] = []
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue
        const e = entry as Partial<FindingCorroboration>
        if (typeof e.source !== 'string' || e.source.length === 0) continue
        if (typeof e.advisoryId !== 'string' || e.advisoryId.length === 0) continue
        if (typeof e.severity !== 'string') continue
        out.push({ source: e.source, advisoryId: e.advisoryId, severity: e.severity })
    }
    return out
}

// The one severity ordering, worst first. Everything that sorts, compares or filters by severity goes
// through the helpers below rather than indexing a rank table, so no call site can get the direction
// wrong. There used to be two rank scales pointing in OPPOSITE directions — an ascending one here
// (critical = 0) and a descending one in apps/web/lib/merge-findings.ts (critical = 5), both exported
// under the name SEVERITY_RANK. Moving a comparison between the two silently reversed it, and the
// ascending scale's critical = 0 was a standing falsy-zero trap for `&&`/`||` defaulting.
export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'moderate', 'low', 'info']

// Higher weight = more severe, so "the worst of a group" is a plain MAX. Mirrors severityRankSql in
// packages/db exactly, including the unknown fallback, so JS grouping and SQL aggregates always agree.
const SEVERITY_WEIGHT: Record<Severity, number> = {
    critical: 5,
    high: 4,
    moderate: 3,
    low: 2,
    info: 1
}

// An unrecognized severity weighs as 'moderate', never as its own out-of-band value: callers bucket
// the five known weights and sum them, so anything outside that range would be counted as a finding
// while landing in no bucket. Moderate rather than info because an unknown advisory must not be
// silently downgraded — same policy as scanners/engine/matcher.ts:mapSeverity.
const UNKNOWN_SEVERITY_WEIGHT = SEVERITY_WEIGHT.moderate

// Accepts `string`, not `Severity`: advisory feeds hand us whatever they like, and findings.severity is
// a plain TEXT column with no CHECK constraint. Case and surrounding whitespace are normalized so a
// source emitting 'HIGH' is not treated as unknown.
export function severityWeight(severity: string): number {
    const normalized = severity.trim().toLowerCase() as Severity
    return SEVERITY_WEIGHT[normalized] ?? UNKNOWN_SEVERITY_WEIGHT
}

// Comparator for Array.prototype.sort: most severe first.
export function compareSeverity(a: string, b: string): number {
    return severityWeight(b) - severityWeight(a)
}

// "Is this finding at or above the floor the caller asked for?" — the shape every minSeverity filter
// wants, without exposing a number for a caller to compare in the wrong direction.
export function meetsSeverityFloor(severity: string, floor: string): boolean {
    return severityWeight(severity) >= severityWeight(floor)
}

// Always returns a declared Severity: an unrecognized input can tie on weight but never wins, so the
// raw string is never echoed back out as though it were a valid severity.
export function maxSeverity(severities: string[]): Severity {
    let best: Severity = 'info'
    let bestWeight = 0
    for (const s of severities) {
        const normalized = s.trim().toLowerCase() as Severity
        const known = SEVERITY_WEIGHT[normalized]
        if (known !== undefined && known > bestWeight) {
            bestWeight = known
            best = normalized
        }
    }
    return best
}

// 'unknown' represents a project that has package.json but no recognized lockfile.
// The worker still records these so operators can see the coverage gap in the catalog;
// the scanner returns status='unauditable' with reason='no lockfile' for them.
export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'unknown'

export type ScanStatus = 'ok' | 'unauditable' | 'error' | 'timeout'

export const SCAN_STATUS_VALUES: ScanStatus[] = ['ok', 'unauditable', 'error', 'timeout']

// Canonical locale set, shared by the localized label maps (reason codes, scan status) and mirrored
// by the web portal's i18n config so the two never drift.
export type Locale = 'en' | 'es' | 'fr' | 'de' | 'pt-BR' | 'it' | 'ja' | 'zh-CN' | 'ko' | 'ru'

export const LOCALES: Locale[] = ['en', 'es', 'fr', 'de', 'pt-BR', 'it', 'ja', 'zh-CN', 'ko', 'ru']

// Structured reason for a scan's terminal state. Maps many freeform failure strings into a stable
// vocabulary so the UI can render a clean label, notifications can dedupe by category, and operators
// can filter by failure mode. Always set; 'ok' for successful scans.
export type ReasonCode =
    | 'ok'
    // unauditable — project cannot be scanned, no tooling fault required
    | 'no_lockfile'
    | 'unknown_pm'
    | 'yarn_v1_unsupported'
    | 'pm_missing'
    | 'nvm_missing'
    | 'node_below_min'
    | 'npm_below_min'
    | 'pnpm_below_min'
    // error — scan attempted but failed
    | 'audit_spawn_error'
    | 'audit_parse_error'
    | 'audit_schema_mismatch'
    | 'audit_empty_output'
    | 'audit_no_advisories'
    | 'legacy_npm6_format'
    | 'nvm_node_missing'
    | 'nvm_install_failed'
    | 'bash_missing'
    | 'audit_unknown_failure'
    // osv — the OSV scanner could not run against its local cache
    | 'osv_db_not_seeded'
    | 'osv_db_unavailable'
    // gemnasium — the gemnasium scanner could not run against its local cache
    | 'gemnasium_db_not_seeded'
    | 'gemnasium_db_unavailable'
    // resolver — non-npm dependency resolution coverage states (Phase 4, offline honesty). A polyglot
    // project's manifest may not yield exact installed versions offline; these codes make the limit
    // operator-visible instead of silently implying full coverage.
    //   - partial_dependency_graph : some dependencies resolved to exact versions, others could not
    //     (e.g. a requirements.txt mixing `==` pins with ranges; Go's offline graph isn't guaranteed full).
    //   - ambiguous_dependency_spec : a manifest exists but pins nothing auditable (all ranges / markers /
    //     editable / `-r`/`-c` includes), so no exact version could be extracted.
    //   - unsupported_lockfile     : a manifest/lockfile format we don't yet parse for this ecosystem.
    //   - ecosystem_source_disabled: the ecosystem's manifests were found but no advisory source is
    //     enabled for it, so it cannot be audited (surfaced per the "always a source on" model).
    | 'partial_dependency_graph'
    | 'ambiguous_dependency_spec'
    | 'unsupported_lockfile'
    | 'ecosystem_source_disabled'
    // timeout
    | 'timeout'

export const REASON_CODE_VALUES: ReasonCode[] = [
    'ok',
    'no_lockfile',
    'unknown_pm',
    'yarn_v1_unsupported',
    'pm_missing',
    'nvm_missing',
    'node_below_min',
    'npm_below_min',
    'pnpm_below_min',
    'audit_spawn_error',
    'audit_parse_error',
    'audit_schema_mismatch',
    'audit_empty_output',
    'audit_no_advisories',
    'legacy_npm6_format',
    'nvm_node_missing',
    'nvm_install_failed',
    'bash_missing',
    'audit_unknown_failure',
    'osv_db_not_seeded',
    'osv_db_unavailable',
    'gemnasium_db_not_seeded',
    'gemnasium_db_unavailable',
    'partial_dependency_graph',
    'ambiguous_dependency_spec',
    'unsupported_lockfile',
    'ecosystem_source_disabled',
    'timeout'
]

// The reason codes that mean an advisory source could not be consulted AT ALL — the cache was never
// downloaded, or could not be opened. A scan reporting zero findings for one of these has not found
// nothing; it has looked at nothing, and the two are indistinguishable in the output.
//
// This exists so a CI gate can refuse to pass such a run. It is deliberately narrow. The codes NOT here
// describe a project with nothing auditable in it — no_lockfile, unsupported_lockfile,
// ambiguous_dependency_spec, partial_dependency_graph, ecosystem_source_disabled — and failing on those
// would break gating any folder containing one unresolvable project, which is the normal case for a
// mixed-language tree. Whether the audit_* family (npm audit itself failing to run) belongs here too is
// a real question, deliberately left open rather than answered by widening this quietly.
export const SOURCE_UNAVAILABLE_REASON_CODES: ReasonCode[] = [
    'osv_db_not_seeded',
    'osv_db_unavailable',
    'gemnasium_db_not_seeded',
    'gemnasium_db_unavailable'
]

export function isSourceUnavailableReason(code: string): boolean {
    return (SOURCE_UNAVAILABLE_REASON_CODES as string[]).includes(code)
}

// reasonCodeLabel + scanStatusLabel and their localized maps live in ./reason-code-labels and
// ./scan-status-labels (re-exported from the barrel). They're kept out of this file so the label
// data stays separate from the type/vocabulary definitions.

export type ScanRequestStatus = 'pending' | 'running' | 'done' | 'failed'

export type Root = {
    id: string
    path: string
    label: string | null
    createdAt: number
}

export type Project = {
    id: string
    rootId: string
    relPath: string
    name: string
    alias: string | null
    packageManager: PackageManager
    nvmrcVersion: string | null
    // Checked-out git branch at the time the project was last discovered or scanned, read from
    // .git/HEAD. A short commit sha when HEAD is detached, and null when the directory is not a git
    // checkout — which is a normal state, not an error.
    gitBranch: string | null
    // The set of ecosystems (EcosystemId) whose manifests discovery found in this project's directory —
    // one project spans many ecosystems (Phase 4). `packageManager` stays the npm-specific detail for the
    // npm-audit/nvm path; this is the polyglot view. Empty for legacy rows discovered before polyglot.
    ecosystems: EcosystemId[]
    muted: boolean
    tags: string[]
    createdAt: number
    updatedAt: number
}

export type Scan = {
    id: string
    projectId: string
    startedAt: number
    finishedAt: number
    // `scanner` is the scanner *plugin* name (implementation detail used for per-scanner merge scoping).
    // `source` is the persisted source identity (SourceId); `ecosystem` is the language ecosystem this
    // scan ran against (EcosystemId). For the current sources source === scanner, but they are kept
    // separate so a (source, ecosystem) cell is two orthogonal axes (Issue #004).
    scanner: string
    source: string
    ecosystem: string
    status: ScanStatus
    reasonCode: ReasonCode | null
    durationMs: number
    errorText: string | null
    rawJson: string
}

export type Finding = {
    id: string
    // The scan that first detected this episode. Kept stable across continuing scans.
    scanId: string
    projectId: string
    // `scanner` = scanner plugin name (merge scoping + provenance display). `source` = persisted source
    // identity (SourceId). `ecosystem` = the package's language ecosystem (EcosystemId). The finding
    // identity tuple is (projectId, source, ecosystem, advisoryId, packageName).
    scanner: string
    source: string
    ecosystem: string
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    packageName: string
    installedVersion: string
    vulnerableRange: string
    // The worst grade any source gave this finding, which is not always the surviving source's own —
    // see `corroborations` for what each source actually said.
    severity: Severity
    // Other sources that independently reported this same advisory for this same package. Empty when
    // only one source knows about it, which is the case worth distinguishing: on a real instance two
    // thirds of findings are corroborated, and without this they looked identical to the third that
    // are not.
    corroborations: FindingCorroboration[]
    fixAvailable: boolean
    fixVersion: string | null
    depPath: string[]
    // A transitive can be reached from both prod and dev direct deps — both flags can be true.
    // Unmappable findings default to isProd=true,isDev=false so they remain visible in the prod-only view.
    isProd: boolean
    isDev: boolean
    // Lifecycle fields. firstDetectedAt and lastSeenAt are always set for any row written by the
    // worker; the nullable typing reflects only the brief pre-backfill window for legacy rows.
    firstDetectedAt: number | null
    lastSeenAt: number | null
    // resolvedAt = null means this episode is still open. When set, resolvedScanId points at the
    // 'ok' scan that first observed this finding gone.
    resolvedAt: number | null
    resolvedScanId: string | null
}

export type DepTypeFilter = 'all' | 'prod' | 'dev'

export type FindingIdentity = {
    projectId: string
    source: string
    ecosystem: string
    advisoryId: string
    packageName: string
}

export function findingIdentity(finding: Pick<Finding, 'projectId' | 'source' | 'ecosystem' | 'advisoryId' | 'packageName'>): FindingIdentity {
    return {
        projectId: finding.projectId,
        source: finding.source,
        ecosystem: finding.ecosystem,
        advisoryId: finding.advisoryId,
        packageName: finding.packageName
    }
}

export type ScanRequest = {
    id: string
    projectId: string | null
    rootId: string | null
    requestedAt: number
    pickedUpAt: number | null
    finishedAt: number | null
    heartbeatAt: number | null
    status: ScanRequestStatus
}

// A 'running' scan_requests row whose heartbeat is older than this is treated as dead.
// 12x the worker's 5s ping interval — tolerates short DB contention or GC pauses without
// flapping, but reclaims a crashed worker's row within a minute.
export const SCAN_HEARTBEAT_STALE_MS = 60_000

export type AppConfigEntry = {
    key: string
    value: unknown
}

export type NotificationTargetKind = 'slack' | 'telegram' | 'webhook'

export type SlackTargetConfig = {
    webhookUrl: string
}

export type TelegramTargetConfig = {
    botToken: string
    chatId: string
}

// Webhook payload shape, chosen per target:
//   - 'json' : a structured { root, project, vulnerabilities[] } body for an auto-fix agent.
//   - 'text' : { text } carrying the LLM-oriented advisory export markdown (same as the portal's
//              "Advisory export"), so the recipient can pipe it straight into a model.
// Optional for back-compat — readers default to 'json' when unset.
export type WebhookFlavor = 'json' | 'text'

export type WebhookTargetConfig = {
    url: string
    headers?: Record<string, string>
    flavor?: WebhookFlavor
}

export type NotificationTargetConfig = SlackTargetConfig | TelegramTargetConfig | WebhookTargetConfig

export type NotificationTarget = {
    id: string
    kind: NotificationTargetKind
    config: NotificationTargetConfig
    severityFilter: Severity[]
    // Environment scope, mirrors DepTypeFilter:
    //   - 'all'  : fire for every finding regardless of prod/dev
    //   - 'prod' : fire only for findings on a production dependency
    //   - 'dev'  : fire only for findings reachable solely from devDependencies
    // scan_failure events bypass this filter (operational signals always pass).
    envFilter: DepTypeFilter
    enabled: boolean
    createdAt: number
    // Per-target scope. Empty rootIds AND empty projectIds = "everything" (zero scope rows). When
    // either is non-empty the target fires only for events whose project belongs to one of these
    // root ids OR whose project id is in projectIds (additive allow-list). Dispatch enforces this in
    // SQL — see selectDispatchablePairs.
    rootIds: string[]
    projectIds: string[]
    // Per-target (source, ecosystem) cell scope. mode 'all' fires for every cell; mode 'selected'
    // fires only for findings whose (source, ecosystem) is in `cells`. Dispatch filters finding events
    // by this; operational (scan_failure) events bypass it. Defaults to { mode: 'all', cells: [] }.
    sourceScope: NotificationSourceScope
}

export type MuteScope = 'project' | 'finding'

export type Mute = {
    id: string
    scope: MuteScope
    projectId: string | null
    // For scope=finding the identity tuple is (projectId?, scanner-as-source, ecosystem, advisoryId,
    // packageName). `ecosystem` disambiguates same-named packages across ecosystems so an npm mute never
    // silences a PyPI package of the same name. null for scope=project (applies across all cells).
    scanner: string | null
    ecosystem: string | null
    advisoryId: string | null
    packageName: string | null
    reason: string
    author: string
    createdAt: number
    expiresAt: number | null
}

export type NotificationEventType = 'finding' | 'scan_failure'

export type NotificationEvent = {
    id: string
    eventType: NotificationEventType
    identityKey: string
    projectId: string
    // `scanner` carries the persisted source identity; `ecosystem` is part of the dedupe identity for
    // finding events (null for scan_failure events, which key on (projectId, scanner, status, signature)).
    scanner: string
    ecosystem: string | null
    advisoryId: string | null
    packageName: string | null
    // Severity is denormalized onto the event for findings so the dispatch query can apply the
    // target's severity_filter in SQL without reverse-mapping through historical finding rows.
    // null for scan_failure events (they bypass severity filtering).
    severity: Severity | null
    failureSignature: string | null
    firstScanId: string
    firstSeenAt: number
    firstNotifiedAt: number | null
    lastSeenAt: number
}

export type NotificationDelivery = {
    id: string
    eventId: string
    // Nullable: when the parent notification_target is deleted, SQLite sets this to NULL (ON DELETE
    // SET NULL on the FK) so the delivery row survives as an audit trail of "we sent this once, to
    // a target that no longer exists". Dispatch/backfill readers all filter by concrete targetId
    // and SQL-drop the orphan rows naturally.
    targetId: string | null
    firstAttemptedAt: number | null
    firstSucceededAt: number | null
    lastAttemptedAt: number | null
    lastErrorText: string | null
}
