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
// v4: MERGE every affected[] entry for the same package instead of keeping only the first. OSV records
//     routinely carry one affected entry PER RELEASE BRANCH for a single package (minimatch ships eight),
//     and the old first-wins skip silently discarded all but one — 1,927 ranges across the npm export
//     alone, every one a missed vulnerable interval. Forces a re-seed to recover them.
// Lives beside the row type it describes so every store — the portal's SQLite cache and the CLI's ndjson
// cache alike — invalidates on exactly the same signal.
export const OSV_NORMALIZER_VERSION = 4

// gemnasium states its affected set as plain introduced/fixed pairs — no range `type` discriminator and no
// `last_affected` equivalent — so it stays a distinct shape rather than being force-fitted onto OsvRange.
export type GemnasiumRange = {
    introduced: string
    fixed: string | null
}

// Where a gemnasium row's version ranges actually came from. gemnasium files whose `affected_range` is the
// empty-set sentinel `<0` carry NO machine-readable range, so the range has to be recovered from a weaker
// source — and which one it was is worth recording, both to order the recovery passes and to keep the
// provenance auditable rather than silently synthesised.
//   'range'      — parsed from the advisory's own `affected_range` (authoritative).
//   'prose'      — parsed from the generated `affected_versions` sentence, in-record but weaker.
//   'sibling'    — copied from another gemnasium advisory for the SAME package that lists this row's id as
//                  an alias (the CVE-keyed twin of a GHSA-keyed stub). Beats 'prose': where both exist they
//                  agree 438/442 times, and in all four disagreements the sibling is the narrower, correct
//                  one (uuid GHSA-w5hq-g745-h8pq: sibling excludes the patched 11.1.1/12.0.1/13.0.1, prose
//                  sweeps everything below 14.0.0 into the finding).
//   'osv'        — recovered from the local OSV cache, only when the operator has the OSV source enabled.
//   'unresolved' — no range recovered yet. Carries NO ranges, so it can never match; the worker's
//                  resolution pass either fills it in or deletes the row. Never fabricate one.
export type GemnasiumRangeSource = 'range' | 'prose' | 'sibling' | 'osv' | 'unresolved'

// One denormalized advisory→package row from gemnasium-db. Mirrors OsvAdvisoryRow field for field apart
// from the range shape and `rangeSource`, so both stores and both scanners read alike.
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
    rangeSource: GemnasiumRangeSource
}

// Bump whenever the gemnasium normalizer's output shape changes in a way that requires rebuilding the
// cache. v1: initial npm-only normalization (affected_range + fixed_versions → {introduced, fixed}).
// v2 (Phase 4): multi-ecosystem — parses npm + PyPI + Go + crates.io package-type dirs and stamps the
// registry ecosystem id (PyPI names PEP 503-normalized), so an existing npm-only cache must rebuild.
// v3: stop fabricating a range for the `affected_range: "<0"` empty-set sentinel. The old code parsed the
//     sentinel correctly to an empty interval and then OVERWROTE it with [0, fixed_versions[0]) — turning
//     "affects nothing" into "affects everything below an arbitrarily-picked branch fix" (protobufjs 7.6.5
//     and every vite below 8.0.5 were reported critical by that path). Adds `rangeSource` + the recovery
//     tiers, so an existing cache must rebuild.
// v4: drop advisories gemnasium has retracted upstream. Its schema carries no `withdrawn` field — unlike
//     OSV, whose formal one we already filter on, and unlike GitHub, which removes withdrawn entries from
//     the database npm-audit reads — so a retracted gemnasium record stays in the export with only its
//     title rewritten ("False Positive", "Withdrawn Advisory: …", "Duplicate Advisory: …") while still
//     naming the versions it claimed beforehand. 372 such records across npm/PyPI/Go/crates.io were being
//     reported as live findings, npm's express among them. Forces a re-seed so the cached rows go.
export const GEMNASIUM_NORMALIZER_VERSION = 4
