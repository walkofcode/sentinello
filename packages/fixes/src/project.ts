import { errText, type Remediation } from '@sentinello/core'
import type { NpmPackageSummary } from '@sentinello/feeds'
import type { FixEvidence, ResolvedGraph } from '@sentinello/scanners'
import type { RegistryClient, RegistryEntry } from './registry-client'
import { computeRemediations, type RemediationRequest } from './remediation'
import type { ReplacementDataset } from './replacements'
import { settleFix, type FixSettlement, type PublishedVersion, type RegistryView } from './settle'

// Every surviving finding of one project scan, settled against the registry after EVERY source has run,
// and the way out for each one settled 'none_released'. The one entry point the worker and the CLI share:
// each calls it once per project and persists (or prints) what it returns. It writes nothing.
//
// Why once, over all evidence, and not inside each scanner's pass: the fix must be outside every source's
// affected set and at or above every installed copy, and each scanner's own pass sees only the evidence
// gathered so far. Settling once is what makes the answer independent of scanner order.
//
// Only npm is checked against a registry (D1); every other ecosystem settles as `unverified` with the
// fix its sources state, and gets no way out.

// What identifies a finding to settlement: findings that share it share their evidence, so they settle
// the same way.
export type FixIdentity = { source: string; ecosystem: string; advisoryId: string; packageName: string }

export type SettleProjectInput = {
    findings: readonly FixIdentity[]
    // Every source's and every installed copy's evidence, keyed by fixEvidenceKey of the surviving finding.
    evidence: ReadonlyMap<string, readonly FixEvidence[]>
    // The project's npm graph; null when the project has none (no lockfile, or one we cannot parse).
    graph: ResolvedGraph | null
    registry: RegistryClient
    checkedAt: number
    dataset?: ReplacementDataset
}

export type ProjectSettlement = {
    // One per finding identity (fixEvidenceKey).
    settlements: Map<string, FixSettlement>
    // One per 'none_released' npm finding identity; empty when the way out could not be computed.
    remediations: Map<string, Remediation>
    // Why the way out could not be computed. The settlements stand regardless: a finding with no way out
    // still says that no fixed version is released.
    wayOutError: string | null
}

const REGISTRY_ECOSYSTEM = 'npm'

export function fixEvidenceKey(identity: FixIdentity): string {
    return identity.source + '|' + identity.ecosystem + '|' + identity.advisoryId + '|' + identity.packageName
}

// A failure to reach the registry is not a failure here: it settles the finding `unverified`. Only a
// failure of the client itself (its store) rejects.
export async function settleProject(input: SettleProjectInput): Promise<ProjectSettlement> {
    const settlements = new Map<string, FixSettlement>()
    const remediations = new Map<string, Remediation>()
    if (input.findings.length === 0) return { settlements, remediations, wayOutError: null }
    const npmNames = input.findings
        .filter(function onRegistry(f) { return f.ecosystem === REGISTRY_ECOSYSTEM })
        .map(function nameOf(f) { return f.packageName })
    const entries = npmNames.length > 0 ? await input.registry.lookup(npmNames) : new Map<string, RegistryEntry>()
    for (const finding of input.findings) {
        const key = fixEvidenceKey(finding)
        if (settlements.has(key)) continue
        settlements.set(key, settleFix({
            evidence: input.evidence.get(key) ?? [],
            registry: finding.ecosystem === REGISTRY_ECOSYSTEM ? registryView(entries.get(finding.packageName)) : null,
            checkedAt: input.checkedAt
        }))
    }
    try {
        await wayOut(input, settlements, remediations)
    } catch (err) {
        return { settlements, remediations: new Map(), wayOutError: errText(err) }
    }
    return { settlements, remediations, wayOutError: null }
}

// One advisory's guidance is the same for every finding that carries the same evidence, so it is computed
// once per (package, affected sets, installed copies).
async function wayOut(input: SettleProjectInput, settlements: Map<string, FixSettlement>, out: Map<string, Remediation>): Promise<void> {
    const requests: RemediationRequest[] = []
    const requestOf = new Map<string, number>()
    const forKey = new Map<string, number>()
    for (const finding of input.findings) {
        const key = fixEvidenceKey(finding)
        // Only npm settles against the registry, so only npm can be none_released — and only from
        // evidence, so its evidence is there.
        if ((settlements.get(key) as FixSettlement).fixStatus !== 'none_released' || forKey.has(key)) continue
        const evidence = input.evidence.get(key) as readonly FixEvidence[]
        const target = { name: finding.packageName, affected: evidence.map(function affectedOf(e) { return e.affected }) }
        const installed = [...new Set(evidence.flatMap(function installedOf(e) { return e.installed }))].sort()
        const requestKey = JSON.stringify([target.name, target.affected, installed])
        let index = requestOf.get(requestKey)
        if (index === undefined) {
            index = requests.push({ target, installed }) - 1
            requestOf.set(requestKey, index)
        }
        forKey.set(key, index)
    }
    if (requests.length === 0) return
    const built = await computeRemediations(requests, { graph: input.graph?.nodeGraph ?? null, registry: input.registry, checkedAt: input.checkedAt, dataset: input.dataset })
    for (const [key, index] of forKey) out.set(key, built[index] as Remediation)
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
