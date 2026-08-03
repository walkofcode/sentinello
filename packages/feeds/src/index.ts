// Advisory feed I/O + parsing, with no storage opinion at all.
//
// Every export here turns a remote feed into normalized advisory rows. Persisting those rows is the
// caller's business: the worker writes them into osv.db / gemnasium.db through drizzle, and the CLI writes
// them as gzipped ndjson under the user's cache dir. That split is deliberate — it keeps @sentinello/db
// (and therefore better-sqlite3, a native module with an install script) out of the published CLI bundle,
// while both products still share one downloader, one unzipper, one normalizer, and one freshness rule.

export {
    OSV_INCREMENTAL_MAX_IDS,
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

export {
    DOWNLOAD_TIMEOUT_MS,
    errText,
    getJson,
    getJsonOrNull,
    getTextConditional,
    getTextOrNull,
    headFile,
    openDownloadStream
} from './http'
export { DEFAULT_RETRY_WAIT_MS } from './http'
export type { ConditionalResult, DownloadStream, FetchOptions, ProgressReporter, RemoteFileInfo, RetryNotice } from './http'
