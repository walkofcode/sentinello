// The one fix logic the worker and the CLI share. settleProject is the entry point: everything else here is
// what it is built from, exported for the callers that test or wire one part of it.
export { settleProject, fixEvidenceKey, npmOnlyWayOut, WAY_OUT_NPM_ONLY, type FixIdentity, type ProjectSettlement, type SettleProjectInput } from './project'
export { createRegistryClients, publicationFor, type RegistryClients, type RegistryClientsOptions, type RegistryStoreFor } from './registry-clients'
export {
    createPublishedRegistryClient,
    liveVersions,
    npmPublication,
    parsePublishedSummary,
    publishedVersions,
    registryView,
    type PublicationClient
} from './published-registry'
export { createGoRegistryClient, GO_INFO_CHECKS_PER_MODULE, parseGoSummary, type GoInfoCheck, type GoModuleSummary, type GoRegistryClientOptions } from './go-registry'
export {
    settleFix,
    affectedSetText,
    statedFixCandidates,
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
    createCachedRegistry,
    createNpmRegistryClient,
    parseSummary,
    REGISTRY_FETCH_CONCURRENCY,
    REGISTRY_FRESH_MS,
    type CachedEntry,
    type CachedRegistry,
    type CachedRegistryOptions,
    type CachedRegistrySpec,
    type Limiter,
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
