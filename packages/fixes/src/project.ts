import { computesWayOut, errText, requireComparator, WAY_OUT_NPM_ONLY, type Remediation } from '@sentinello/core'
import type { FixEvidence, ResolvedGraph } from '@sentinello/scanners'
import type { PublicationClient } from './published-registry'
import type { RegistryClient } from './registry-client'
import { publicationFor, type RegistryClients } from './registry-clients'
import { computeRemediations, type RemediationRequest } from './remediation'
import type { ReplacementDataset } from './replacements'
import { settleFix, statedFixCandidates, type FixSettlement, type RegistryView } from './settle'

// Every surviving finding of one project scan, settled against its ecosystem's registry after EVERY source
// has run, and the way out for each one settled 'none_released'. The one entry point the worker and the CLI
// share: each calls it once per project and persists (or prints) what it returns. It writes nothing.
//
// Why once, over all evidence, and not inside each scanner's pass: the fix must be outside every source's
// affected set and at or above every installed copy, and each scanner's own pass sees only the evidence
// gathered so far. Settling once is what makes the answer independent of scanner order.
//
// Each ecosystem is checked against its own registry when the run has a client for it (the worker has one
// for every ecosystem; the CLI, npm only for now); one with no client settles as `unverified` with the fix
// its sources state. The way out is computed for npm only (SENTINEL-119): a 'none_released' finding of any
// other ecosystem gets the `unknown` verdict saying so. A run with no registry clients at all (the CLI's
// --offline) makes no request: every finding settles `unverified`, marked offline, with no way out.
// What identifies a finding to settlement: findings that share it share their evidence, so they settle
// the same way.
export type FixIdentity = { source: string; ecosystem: string; advisoryId: string; packageName: string }

export type SettleProjectInput = {
    findings: readonly FixIdentity[]
    // Every source's and every installed copy's evidence, keyed by fixEvidenceKey of the surviving finding.
    evidence: ReadonlyMap<string, readonly FixEvidence[]>
    // The project's npm graph; null when the project has none (no lockfile, or one we cannot parse).
    graph: ResolvedGraph | null
    // The registry for each ecosystem the run checks. Null when the run must make no network request (the
    // CLI's --offline).
    registry: RegistryClients | null
    checkedAt: number
    dataset?: ReplacementDataset
}

export type ProjectSettlement = {
    // One per finding identity (fixEvidenceKey).
    settlements: Map<string, FixSettlement>
    // One per 'none_released' finding identity — computed for npm, the `unknown` verdict for every other
    // ecosystem; empty when the way out could not be computed.
    remediations: Map<string, Remediation>
    // Why the way out could not be computed. The settlements stand regardless: a finding with no way out
    // still says that no fixed version is released.
    wayOutError: string | null
}

// What a non-npm 'none_released' finding is told about its way out (SENTINEL-119).

export function fixEvidenceKey(identity: FixIdentity): string {
    return identity.source + '|' + identity.ecosystem + '|' + identity.advisoryId + '|' + identity.packageName
}

// A failure to reach a registry is not a failure here: it settles the finding `unverified`. Only a
// failure of a client itself (its store), or evidence that contradicts its finding, rejects.
export async function settleProject(input: SettleProjectInput): Promise<ProjectSettlement> {
    const settlements = new Map<string, FixSettlement>()
    const remediations = new Map<string, Remediation>()
    if (input.findings.length === 0) return { settlements, remediations, wayOutError: null }
    const clients = input.registry
    const views = clients === null ? new Map<string, Map<string, RegistryView>>() : await registryViews(input, clients)
    for (const finding of input.findings) {
        const key = fixEvidenceKey(finding)
        if (settlements.has(key)) continue
        let view: RegistryView | null = { status: 'offline' }
        if (clients !== null) {
            const answered = views.get(finding.ecosystem)
            // A client answers every package it is asked about; one it did not is unknown, never "no fix".
            view = answered === undefined ? null : answered.get(finding.packageName) ?? { status: 'error' }
        }
        settlements.set(key, settleFix({ ecosystem: finding.ecosystem, evidence: input.evidence.get(key) ?? [], registry: view, checkedAt: input.checkedAt }))
    }
    // Offline, nothing settles 'none_released', so there is no way out to compute.
    if (clients === null) return { settlements, remediations, wayOutError: null }
    try {
        await wayOut(input, clients, settlements, remediations)
    } catch (err) {
        return { settlements, remediations: new Map(), wayOutError: errText(err) }
    }
    return { settlements, remediations, wayOutError: null }
}

// Each ecosystem's registry is asked once, for every package of it in the project, with the fix versions
// the evidence states for each — all ecosystems at once. An ecosystem with no client has no entry.
async function registryViews(input: SettleProjectInput, clients: RegistryClients): Promise<Map<string, Map<string, RegistryView>>> {
    const asks = new Map<string, { client: PublicationClient; stated: Map<string, string[]> }>()
    for (const finding of input.findings) {
        let ask = asks.get(finding.ecosystem)
        if (ask === undefined) {
            const client = publicationFor(clients, finding.ecosystem)
            if (client === null) continue
            ask = { client, stated: new Map() }
            asks.set(finding.ecosystem, ask)
        }
        const candidates = statedFixCandidates(input.evidence.get(fixEvidenceKey(finding)) ?? [], requireComparator(finding.ecosystem))
        ask.stated.set(finding.packageName, [...ask.stated.get(finding.packageName) ?? [], ...candidates])
    }
    const views = new Map<string, Map<string, RegistryView>>()
    await Promise.all([...asks].map(async function askOne([ecosystem, ask]) {
        views.set(ecosystem, await ask.client.published(ask.stated))
    }))
    return views
}

// One advisory's guidance is the same for every finding that carries the same evidence, so it is computed
// once per (package, affected sets, installed copies).
async function wayOut(input: SettleProjectInput, clients: RegistryClients, settlements: Map<string, FixSettlement>, out: Map<string, Remediation>): Promise<void> {
    const requests: RemediationRequest[] = []
    const requestOf = new Map<string, number>()
    const forKey = new Map<string, number>()
    for (const finding of input.findings) {
        const key = fixEvidenceKey(finding)
        // Only a registry answer settles none_released — and only from evidence, so its evidence is there.
        if ((settlements.get(key) as FixSettlement).fixStatus !== 'none_released' || forKey.has(key) || out.has(key)) continue
        if (!computesWayOut(finding.ecosystem)) {
            out.set(key, npmOnlyWayOut(finding.packageName, input.checkedAt))
            continue
        }
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
    // An npm finding settles none_released only from the npm client's answer, so the client is there.
    const registry = clients.npm as RegistryClient
    const built = await computeRemediations(requests, { graph: input.graph?.nodeGraph ?? null, registry, checkedAt: input.checkedAt, dataset: input.dataset })
    for (const [key, index] of forKey) out.set(key, built[index] as Remediation)
}

// The way out of a non-npm finding: nothing is claimed about its health or its paths, and the one verdict
// says why — the dependency proofs and the curated alternatives exist for npm only.
export function npmOnlyWayOut(packageName: string, checkedAt: number): Remediation {
    return {
        v: 1,
        checkedAt,
        package: packageName,
        health: { name: packageName, latest: null, lastPublishAt: null, maintainers: 0, weeklyDownloads: null, deprecated: null, daysSinceLastPublish: null, unmaintained: false },
        chains: [{ importer: null, rootKind: null, path: [], verdict: { kind: 'unknown', at: packageName, reason: WAY_OUT_NPM_ONLY } }],
        moreChains: 0,
        moreChainsAtLeast: false,
        alternatives: [],
        devOnly: null
    }
}
