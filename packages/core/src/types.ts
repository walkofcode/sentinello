export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info'

// Severity ordering. Lower rank = more severe. Mirrors the CASE in listCurrentFindingsForProject
// so client-side grouping/sorting agrees with what the SQL produces.
export const SEVERITY_RANK: Record<Severity, number> = {
    critical: 0,
    high: 1,
    moderate: 2,
    low: 3,
    info: 4
}

export function severityRank(severity: string): number {
    if (severity === 'critical') return 0
    if (severity === 'high') return 1
    if (severity === 'moderate') return 2
    if (severity === 'low') return 3
    return 4
}

export function maxSeverity(severities: string[]): Severity {
    let best: Severity = 'info'
    let bestRank = 4
    for (const s of severities) {
        const r = severityRank(s)
        if (r < bestRank) {
            bestRank = r
            best = s as Severity
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
    'timeout'
]

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
    scanner: string
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
    scanner: string
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    packageName: string
    installedVersion: string
    vulnerableRange: string
    severity: Severity
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
    scanner: string
    advisoryId: string
    packageName: string
}

export function findingIdentity(finding: Pick<Finding, 'projectId' | 'scanner' | 'advisoryId' | 'packageName'>): FindingIdentity {
    return {
        projectId: finding.projectId,
        scanner: finding.scanner,
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
    enabled: boolean
    createdAt: number
    // Per-target scope. Empty rootIds AND empty projectIds = "everything" (zero scope rows). When
    // either is non-empty the target fires only for events whose project belongs to one of these
    // root ids OR whose project id is in projectIds (additive allow-list). Dispatch enforces this in
    // SQL — see selectDispatchablePairs.
    rootIds: string[]
    projectIds: string[]
}

export type MuteScope = 'project' | 'finding'

export type Mute = {
    id: string
    scope: MuteScope
    projectId: string | null
    scanner: string | null
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
    scanner: string
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
