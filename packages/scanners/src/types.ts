import type { FindingCorroboration, Severity, ScanStatus, ReasonCode, PackageManager } from '@sentinello/core'
import type { ResolvedGraph } from './resolver/types'

export type RawFinding = {
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    packageName: string
    // The package's ecosystem (EcosystemId). Set by the matcher engine from the resolved package; the
    // npm-audit scanner builds findings directly and leaves it undefined, so the worker defaults it to
    // the npm ecosystem when stamping the persisted finding.
    ecosystem?: string
    installedVersion: string
    vulnerableRange: string
    severity: Severity
    fixAvailable: boolean
    fixVersion: string | null
    depPath: string[]
    isProd: boolean
    isDev: boolean
    // Cross-reference ids (e.g. ["CVE-2024-48913"]) for advisories that carry them, so reconcile can
    // tell that two sources keying one advisory differently are describing the same thing.
    //
    // EVERY scanner populates this, including npm-audit — it carries the GHSA from its own advisory
    // URL alongside npm's numeric id. This comment used to say npm-audit was the exception, which was
    // true and was the bug: its identity keys could never intersect OSV's or gemnasium's, so the
    // dedup this field exists for never fired on the one pairing that matters.
    aliases?: string[]
    // Other sources that independently reported this same advisory for this same package. Attached by
    // reconcileAgainstReported as later sources agree, so a caller holding the finding — the CLI report,
    // which has no database — sees the agreement without a second lookup. `severity` above is already the
    // worst grade any of them gave.
    corroborations?: FindingCorroboration[]
}

export type ScanResult = {
    status: ScanStatus
    reasonCode: ReasonCode
    findings: RawFinding[]
    rawJson: string
    errorText: string | null
    durationMs: number
}

// Per-ecosystem resolver coverage for one project, threaded into the advisory-feed scanners so they can
// record (in their rawJson) which ecosystems were fully/partially/not auditable this scan. The reason
// codes are stable so Phase 5 can render the disclosure per ecosystem; capturing it here keeps the
// classification end-to-end in Phase 4 rather than silently dropping it.
export type EcosystemCoverage = {
    ecosystem: string
    status: 'ok' | 'partial' | 'unauditable'
    reasonCode?: ReasonCode
    details?: string[]
}

export type ScanContext = {
    timeoutMs: number
    abortSignal?: AbortSignal
    useNvm?: boolean
    // The project's resolved dependency graph, computed once per project by the runner and shared by
    // every scanner so prod/dev classification is identical across sources. Null when the lockfile
    // couldn't be resolved (yarn/unparseable) — sources fall back to their own posture. For polyglot
    // projects this is the merged graph spanning every resolved ecosystem; npm-audit gets the JS-only graph.
    resolvedGraph?: ResolvedGraph | null
    // Per-ecosystem resolver coverage for the ecosystems this scanner answers for (advisory-feed sources
    // record it in rawJson; npm-audit ignores it). Optional/absent for the JS-only path.
    coverage?: EcosystemCoverage[]
}

export type ScannerPlugin = {
    name: string
    scan(projectPath: string, ctx: ScanContext): Promise<ScanResult>
}

export type LockfileKind = 'pnpm-lock.yaml' | 'package-lock.json' | 'yarn.lock'

export type DetectedLockfile = {
    kind: LockfileKind
    packageManager: PackageManager
    absolutePath: string
}
