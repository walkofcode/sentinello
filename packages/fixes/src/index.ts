// The one fix logic the worker and the CLI share. settleProject is the entry point: everything else here is
// what it is built from, exported for the callers that test or wire one part of it.
export { settleProject, fixEvidenceKey, registryView, publishedVersions, type FixIdentity, type ProjectSettlement, type SettleProjectInput } from './project'
export {
    settleFix,
    affectedSetText,
    pickReleasedFix,
    type FixSettlement,
    type PickReleasedFixArgs,
    type PublishedVersion,
    type RegistryView,
    type ReleasedFixResult,
    type SettleFixArgs,
    type UnknownFixReason
} from './settle'
export {
    createNpmRegistryClient,
    parseSummary,
    REGISTRY_FETCH_CONCURRENCY,
    REGISTRY_FRESH_MS,
    type NpmRegistryClientOptions,
    type PackumentRequest,
    type RegistryClient,
    type RegistryEntry,
    type RegistryRow,
    type RegistryStore
} from './registry-client'
export { createMemoryRegistryStore } from './memory-store'
export { computeRemediations, findChains, type RemediationContext, type RemediationRequest } from './remediation'
export { createReplacementDataset, type CuratedEntry, type CuratedReplacement, type ReplacementDataset } from './replacements'
