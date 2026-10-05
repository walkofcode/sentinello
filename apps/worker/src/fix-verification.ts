import { errText, type Finding, type FixFields } from '@sentinello/core'
import { applyFixSettlement, applyRemediation, type DrizzleDb } from '@sentinello/db'
import { fixEvidenceKey, settleProject, type FixSettlement, type RegistryClient } from '@sentinello/fixes'
import type { FixEvidence, ResolvedGraph } from '@sentinello/scanners'

// The worker's side of the shared fix logic: one settleProject call per project scan, after every source
// has run, then what it returned is persisted — the settlements first, then the way out — and folded back
// onto the in-memory findings, the objects the notifier reads, so a notification describes exactly what
// the row now holds.

export type VerifyFixesInput = {
    db: DrizzleDb
    findings: Finding[]
    // Every source's and every installed copy's evidence, keyed by fixEvidenceKey of the surviving finding.
    evidence: Map<string, FixEvidence[]>
    // The project's npm graph; null when the project has none (no lockfile, or one we cannot parse).
    graph: ResolvedGraph | null
    registry: RegistryClient
    checkedAt: number
}

// Rejects when the settlements could not be computed or written: the rows stay unsettled, which reads
// "rescan pending". A way out that could not be computed or written does not reject — the settlements are
// already persisted and stand — it is returned as `wayOutError`, and those findings carry no way out.
export async function verifyFixes(input: VerifyFixesInput): Promise<{ wayOutError: string | null }> {
    const result = await settleProject(input)
    const persisted = applyFixSettlement(input.db, input.findings.map(function write(finding) {
        // settleProject settles every finding it is given.
        return { id: finding.id, ...(result.settlements.get(fixEvidenceKey(finding)) as FixSettlement) }
    }))
    for (const finding of input.findings) {
        // Every finding was written above, so every one has its persisted fields.
        const fields = persisted.get(finding.id) as FixFields
        finding.fixStatus = fields.fixStatus
        finding.fixVersion = fields.fixVersion
        finding.fixAvailable = fields.fixAvailable
        finding.fixCheck = fields.fixCheck
        // Always null here: settlement clears the way out, which is written next.
        finding.remediation = fields.remediation
    }
    if (result.wayOutError !== null) return { wayOutError: result.wayOutError }
    try {
        const written = applyRemediation(input.db, input.findings.flatMap(function write(finding) {
            const remediation = result.remediations.get(fixEvidenceKey(finding))
            return remediation ? [{ id: finding.id, remediation }] : []
        }))
        // Only what was persisted is folded back.
        for (const finding of input.findings) {
            const remediation = written.get(finding.id)
            if (remediation) finding.remediation = remediation
        }
    } catch (err) {
        return { wayOutError: errText(err) }
    }
    return { wayOutError: null }
}
