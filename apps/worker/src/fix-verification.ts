import { applyFixSettlement, type DrizzleDb, type FixSettlementWrite } from '@sentinello/db'
import type { Finding, FixFields } from '@sentinello/core'
import type { NpmPackageSummary } from '@sentinello/feeds'
import { settleFix, type FixEvidence, type PublishedVersion, type RegistryView } from '@sentinello/scanners'
import type { RegistryClient, RegistryEntry } from './registry-client'

// Settles every surviving finding of one project scan against the registry, after EVERY source has run.
//
// Why here and not inside each scanner's pass: the fix must be outside every source's affected set and at
// or above every installed copy, and each scanner's own pass sees only the evidence gathered so far — its
// row is written before later sources run. Settling once, over all evidence, is what makes the answer
// independent of scanner order.
//
// Only npm is checked against a registry (D1); every other ecosystem settles as `unverified` with the
// fix its sources state.

export type SettleFixesInput = {
    db: DrizzleDb
    findings: Finding[]
    // Every source's and every installed copy's evidence, keyed by fixEvidenceKey of the surviving finding.
    evidence: Map<string, FixEvidence[]>
    registry: RegistryClient
    checkedAt: number
}

export function fixEvidenceKey(identity: { source: string; ecosystem: string; advisoryId: string; packageName: string }): string {
    return identity.source + '|' + identity.ecosystem + '|' + identity.advisoryId + '|' + identity.packageName
}

const REGISTRY_ECOSYSTEM = 'npm'

// Writes fix_status, fix_version, fix_available and fix_check_json for every finding in one transaction,
// then folds what was persisted back onto the in-memory findings — the objects the notifier reads — so a
// notification describes exactly the fix the row now holds.
export async function settleFixes(input: SettleFixesInput): Promise<void> {
    if (input.findings.length === 0) return
    const npmNames = input.findings
        .filter(function onRegistry(f) { return f.ecosystem === REGISTRY_ECOSYSTEM })
        .map(function nameOf(f) { return f.packageName })
    const entries = npmNames.length > 0 ? await input.registry.lookup(npmNames) : new Map<string, RegistryEntry>()
    const writes: FixSettlementWrite[] = []
    for (const finding of input.findings) {
        const view = finding.ecosystem === REGISTRY_ECOSYSTEM ? registryView(entries.get(finding.packageName)) : null
        const settled = settleFix({
            evidence: input.evidence.get(fixEvidenceKey(finding)) ?? [],
            registry: view,
            checkedAt: input.checkedAt
        })
        writes.push({ id: finding.id, ...settled })
    }
    const persisted = applyFixSettlement(input.db, writes)
    for (const finding of input.findings) {
        // Every finding was written above, so every one has its persisted fields.
        const fields = persisted.get(finding.id) as FixFields
        finding.fixStatus = fields.fixStatus
        finding.fixVersion = fields.fixVersion
        finding.fixAvailable = fields.fixAvailable
        finding.fixCheck = fields.fixCheck
        // Always null here: the way-out, if any, is written after settlement (buildRemediations).
        finding.remediation = fields.remediation
    }
}

// What the settlement may conclude from one registry answer. A missing entry (the lookup did not answer
// for the package) is an error: unknown, never "no fix".
export function registryView(entry: RegistryEntry | undefined): RegistryView {
    if (!entry || entry.status === 'error') return { status: 'error' }
    if (entry.status === 'not_found') return { status: 'not_found', dataAsOf: entry.checkedAt }
    return { status: entry.status, published: publishedVersions(entry.summary), dataAsOf: entry.checkedAt }
}

export function publishedVersions(summary: NpmPackageSummary): PublishedVersion[] {
    return Object.entries(summary.versions).map(function toPublished([version, meta]) {
        return { version, deprecated: meta.deprecated !== null }
    })
}
