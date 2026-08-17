// The normalized advisory→package row shapes produced by the feed normalizers and consumed by every
// advisory store. They live in core, not in @sentinello/db, because the normalizers must be usable
// WITHOUT a database: the CLI keeps its advisory cache as gzipped ndjson and never links better-sqlite3,
// so a row type that transitively pulled in the drizzle/native-module layer would drag the whole SQLite
// stack into an npx-distributed bundle. @sentinello/db re-exports these under its historical names, so
// every existing import site keeps working and the persisted column mapping stays db's business.

// Both feeds normalize into the ONE range type, `VersionRange` from @sentinello/versions. These two names
// remain because the row shapes are named after their feeds and ~40 import sites read better that way —
// but they are aliases, not separate declarations, and that is the point.
//
// They used to be two independent shapes (OSV's with `type` + `lastAffected`, gemnasium's with neither),
// restated structurally in the scanners package, again inline in the worker, and rebuilt field-by-field by
// the db read path. Five copies of one concept, converted at every boundary — which is how the db's
// reconstruction came to silently drop any field the others added, and how gemnasium ended up with no way
// to express an inclusive upper bound at all despite the matcher having supported one for OSV all along.
export type { VersionRange } from '@sentinello/versions'

import type { VersionRange } from '@sentinello/versions'

export type OsvRange = VersionRange

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
// v5: read the upper bound GitHub parks in an affected entry's `database_specific.
//     last_known_affected_version_range` when it cannot state the fix as a `fixed` event — which is what it
//     does whenever the fixed version is not published under that package name on the registry. xlsx
//     GHSA-4r6h-8v6p-xvw6 (`< 0.19.3`) and GHSA-5pgg-2g8v-p4x9 (`< 0.20.2`) were stored as `>=0` and
//     reported the fully patched 0.20.3 as high severity with no fix, 22 findings across 11 projects;
//     `babel-traverse` GHSA-67hx-6x53-jw92 and `sandbox` are the same shape. Applied ONLY to an entry that
//     produced a single range with no upper bound — GHSA-25hc-qcg6-38wj states `< 2.5.0` while its real
//     branch fixes are 2.5.1 and 4.6.2, so as a supplement it would narrow a correct range into a false
//     negative. Every cached range is re-derived, so an existing cache must rebuild.
// Lives beside the row type it describes so every store — the portal's SQLite cache and the CLI's ndjson
// cache alike — invalidates on exactly the same signal.
export const OSV_NORMALIZER_VERSION = 5

// gemnasium carries no range `type` discriminator, so its rows leave that field unset — but it very much
// does state inclusive upper bounds (`<=X`, maven `[a,b]`) and exclusive lower ones (`>X`), so it uses the
// same range type as OSV rather than a reduced one that cannot represent them.
export type GemnasiumRange = VersionRange

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
// v3: stop fabricating a range for the `affected_range: "<0"` empty-set sentinel. The old code parsed the
//     sentinel correctly to an empty interval and then OVERWROTE it with [0, fixed_versions[0]) — turning
//     "affects nothing" into "affects everything below an arbitrarily-picked branch fix" (protobufjs 7.6.5
//     and every vite below 8.0.5 were reported critical by that path). Adds `rangeSource` + the recovery
//     tiers, so an existing cache must rebuild.
// v4: drop advisories gemnasium has retracted upstream. Its schema carries no `withdrawn` field — unlike
//     OSV, whose formal one we already filter on, and unlike GitHub, which removes withdrawn entries from
//     the database npm-audit reads — so a retracted gemnasium record stays in the export with only its
//     title rewritten ("False Positive", "Withdrawn Advisory: …", "Duplicate Advisory: …") while still
//     naming the versions it claimed beforehand. 383 such records across npm/PyPI/Go/crates.io were being
//     reported as live findings, npm's express among them. Also removes the v3 range-recovery tiers: a
//     record whose `affected_range` selects no version now states that it affects nothing and is dropped,
//     rather than having a range rebuilt for it from `affected_versions` — which gemnasium's own field
//     reference calls display text, and which on a retracted record still describes the withdrawn claim.
//     Forces a re-seed so the cached rows go.
// v5: bounds keep their own inclusivity instead of being rounded into a half-open interval. `>X` no longer
//     becomes `>=X` (which reported the boundary version as affected — npm/rc GMS-2021-3 is `>1.2.8`, and
//     1.2.8 is the CLEAN release the advisory tells you to stay on, so every project holding it got a
//     critical, unfixable malware finding). `<=X` and a maven `]` close no longer become exclusive, which
//     had been dropping the boundary version silently, and an advisory spelled `>=X <=X` no longer collapses
//     to an empty interval that discarded the whole record. Range syntax this parser cannot read (`^1.0.0`,
//     `~1.0.0`, `!=1.0.0`) is now refused rather than cached as an exact-version pin that matches nothing
//     forever. Every cached range carries the new fields, so an existing cache must rebuild.
// v6: two range-fidelity fixes, both re-deriving every cached range.
//     (a) An interval left with NO upper bound is now closed at the HIGHEST entry in `fixed_versions` when
//         the record lists any — an unbounded interval claims every version forever and is a finding no
//         upgrade can clear. This runs AFTER the single-fix override above and only ever fires on an
//         interval that is already unbounded, so it cannot repeat the protobufjs GHSA-xq3m-2v4x-88gg
//         regression, which came from overwriting an interval that already had a correct bound. A fix at or
//         below the interval's lower bound is refused rather than used to build an empty range.
//     (b) The comparator-form parser splits on a comma as well as whitespace. PEP 440 spells an
//         intersection as `>=5.0,<5.8`, so splitting on whitespace alone kept the whole thing as one token:
//         the lower bound became the unparseable literal `5.0,<5.8` and the upper bound was lost, leaving
//         2,830 of 7,159 PyPI records matching nothing at all. Retires one of the three blockers README
//         names for Python/Go/Rust remaining `preview`; the other two are unchanged, so they stay there.
export const GEMNASIUM_NORMALIZER_VERSION = 6
