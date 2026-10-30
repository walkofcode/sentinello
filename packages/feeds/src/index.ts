// Advisory feed I/O + parsing, with no storage opinion at all.
//
// Every export here turns a remote feed into normalized advisory rows. Persisting those rows is the
// caller's business: the worker writes them into osv.db / gemnasium.db through drizzle, and the CLI writes
// them as gzipped ndjson under the user's cache dir. That split is deliberate — it keeps @sentinello/db
// (and therefore better-sqlite3, a native module with an install script) out of the published CLI bundle,
// while both products still share one downloader, one unzipper, one normalizer, and one freshness rule.

export {
    OSV_INCREMENTAL_MAX_IDS,
    OSV_INCREMENTAL_STUCK_MS,
    fetchOsvAdvisoryRows,
    fetchOsvChangedIds,
    headOsvSeed,
    osvAdvisoryUrl,
    osvFeedDisabled,
    osvModifiedIdsUrl,
    osvSeedUrl,
    selectChangedIds,
    streamOsvSeed
} from './osv/feed'
export type { ChangedIdSelection, OsvChangedIds, OsvSeedBatch } from './osv/feed'
export { normalizeOsvRecord } from './osv/normalize'

export {
    GEMNASIUM_COMPARE_MAX_FILES,
    advisoryIdFromPath,
    fetchGemnasiumChangedPaths,
    fetchGemnasiumFileRows,
    fetchGemnasiumHeadSha,
    gemnasiumFeedDisabled,
    streamGemnasiumArchive
} from './gemnasium/feed'
export type { GemnasiumArchiveBatch, GemnasiumChangedPaths } from './gemnasium/feed'
export { normalizeGemnasiumRecord, parseAffectedRange } from './gemnasium/normalize'
export { severityFromCvss } from './gemnasium/cvss'

// errText moved to @sentinello/core (a string helper had no business living behind the feed HTTP
// client, and apps/web needed it without taking a dependency on this package). Re-exported here so the
// worker and CLI call sites that already import it from @sentinello/feeds keep resolving.
export { errText } from '@sentinello/core'

export {
    DOWNLOAD_TIMEOUT_MS,
    getJson,
    getJsonOrNull,
    getTextConditional,
    getTextOrNull,
    headFile,
    openDownloadStream
} from './http'
export { DEFAULT_RETRY_WAIT_MS } from './http'
export type { ConditionalResult, DownloadStream, FetchOptions, ProgressReporter, RemoteFileInfo, RetryNotice } from './http'

export {
    DEFAULT_NPM_DOWNLOADS_URL,
    DEFAULT_NPM_REGISTRY_URL,
    NPM_REGISTRY_TIMEOUT_MS,
    fetchNpmPackage,
    fetchNpmWeeklyDownloads,
    npmDownloadsUrl,
    npmPackageUrl,
    npmRegistryUrl,
    summarizePackument
} from './registry/npm'
export type { FetchNpmPackageOptions, FetchNpmPackumentOptions, NpmDownloadsResult, NpmEdges, NpmPackageResult, NpmPackageSummary, NpmVersionSummary } from './registry/npm'

// The other registries settlement checks a fix against, each reduced to the same published summary.
export { REGISTRY_TIMEOUT_MS } from './registry/request'
export type { RegistryFetchOptions, RegistryResult } from './registry/request'
export type { PublishedRelease, PublishedResult, PublishedSummary } from './registry/published'
export { DEFAULT_PYPI_URL, fetchPypiPackage, pypiPackageUrl, pypiUrl, summarizePypiProject } from './registry/pypi'
export { DEFAULT_CRATES_INDEX_URL, cratesIndexPath, cratesIndexUrl, fetchCratesPackage, summarizeCratesIndex } from './registry/crates'
export { DEFAULT_RUBYGEMS_URL, fetchRubyGemsPackage, rubygemsUrl, rubygemsVersionsUrl, summarizeRubyGemsVersions } from './registry/rubygems'
export { DEFAULT_GOPROXY_URL, escapeGoPath, fetchGoModuleList, fetchGoVersionInfo, goproxyUrl, summarizeGoList } from './registry/goproxy'
export type { GoVersionInfoResult } from './registry/goproxy'

