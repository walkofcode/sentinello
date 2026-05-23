import type { Severity, ScanStatus, ReasonCode, PackageManager } from '@sentinello/core'

export type RawFinding = {
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
    isProd: boolean
    isDev: boolean
}

export type ScanResult = {
    status: ScanStatus
    reasonCode: ReasonCode
    findings: RawFinding[]
    rawJson: string
    errorText: string | null
    durationMs: number
}

export type ScanContext = {
    timeoutMs: number
    abortSignal?: AbortSignal
    useNvm?: boolean
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
