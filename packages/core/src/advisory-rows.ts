// The normalized advisory→package row shapes produced by the feed normalizers and consumed by every
// advisory store. They live in core, not in @sentinello/db, because the normalizers must be usable
// WITHOUT a database: the CLI keeps its advisory cache as gzipped ndjson and never links better-sqlite3,
// so a row type that transitively pulled in the drizzle/native-module layer would drag the whole SQLite
// stack into an npx-distributed bundle. @sentinello/db re-exports these under its historical names, so
// every existing import site keeps working and the persisted column mapping stays db's business.

// A normalized OSV version range. `fixed` is null when there is no clean fix boundary; in that case
// `lastAffected` (OSV `last_affected`), when set, is an INCLUSIVE upper bound, and when both are null the
// range is open-ended (vulnerable from `introduced` onward, as every MAL- malicious record is stored).
// `type` is OSV's `range.type` ('SEMVER' | 'ECOSYSTEM' | 'GIT') — preserved so non-SEMVER ecosystems
// (PyPI/Go/Rust) keep enough semantics for their comparator to evaluate the range correctly.
export type OsvRange = {
    type: string
    introduced: string
    fixed: string | null
    lastAffected: string | null
}

// One denormalized advisory→package row, the shape the scanner consumes. `rowKey` is synthesized by
// the writer; callers building rows for upsert pass everything except it.
export type OsvAdvisoryRow = {
    advisoryId: string
    ecosystem: string
    packageName: string
    aliases: string[]
    ranges: OsvRange[]
    // Enumerated affected versions (e.g. malware records list the exact compromised builds like ["4.4.2"]).
    // The matcher checks membership here in addition to `ranges`.
    versions: string[]
    severity: string | null
    summary: string | null
    url: string | null
    malicious: boolean
    withdrawn: number | null
}

// Bump whenever normalizeOsvRecord's output shape changes in a way that requires rebuilding the cache.
// v2: started capturing affected[].versions and real MAL- ranges (was: all-versions malware shortcut).
// v3: per-ecosystem rows (dropped the npm/SEMVER-only filters) + richer range shape (range.type +
//     last_affected) + per-ecosystem meta keys. Forces a full re-seed off the prior flat-key npm cache.
// Lives beside the row type it describes so every store — the portal's SQLite cache and the CLI's ndjson
// cache alike — invalidates on exactly the same signal.
export const OSV_NORMALIZER_VERSION = 3

// gemnasium states its affected set as plain introduced/fixed pairs — no range `type` discriminator and no
// `last_affected` equivalent — so it stays a distinct shape rather than being force-fitted onto OsvRange.
export type GemnasiumRange = {
    introduced: string
    fixed: string | null
}

// One denormalized advisory→package row from gemnasium-db. Mirrors OsvAdvisoryRow field for field apart
// from the range shape, so both stores and both scanners read alike.
export type GemnasiumAdvisoryRow = {
    advisoryId: string
    ecosystem: string
    packageName: string
    aliases: string[]
    ranges: GemnasiumRange[]
    versions: string[]
    severity: string | null
    summary: string | null
    url: string | null
    malicious: boolean
    withdrawn: number | null
}

// Bump whenever the gemnasium normalizer's output shape changes in a way that requires rebuilding the
// cache. v1: initial npm-only normalization (affected_range + fixed_versions → {introduced, fixed}).
// v2 (Phase 4): multi-ecosystem — parses npm + PyPI + Go + crates.io package-type dirs and stamps the
// registry ecosystem id (PyPI names PEP 503-normalized), so an existing npm-only cache must rebuild.
export const GEMNASIUM_NORMALIZER_VERSION = 2
