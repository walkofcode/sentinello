import {
    applyGemnasiumRangeResolutions,
    deleteGemnasiumRowsByKey,
    gemnasiumRowKeyFor,
    listGemnasiumRowsNeedingRanges,
    listGemnasiumSiblingCandidates,
    type GemnasiumAdvisoryRow,
    type GemnasiumDrizzleDb,
    type GemnasiumRange,
    type GemnasiumRangeResolution
} from '@sentinello/db'

// Recovers version ranges for gemnasium records that ship none.
//
// gemnasium writes `affected_range: "<0"` — the empty set — when a record has no machine-readable range,
// which is 698 of 10,777 npm advisories. Those are almost always GHSA-keyed stubs whose CVE-keyed twin, in
// the SAME package directory and cross-referencing the stub in its `identifiers`, carries the real range.
// The normalizer already reads the record's own generated prose as a first fallback; this pass runs after
// a sync, when every advisory is in the cache and siblings can actually be seen.
//
// Tiers, strongest first — each one only runs when the previous found nothing:
//   1. sibling — another gemnasium advisory for the same package listing this row's id as an alias. This
//      is the same feed's own machine-readable range for the same vulnerability, so it outranks prose:
//      across the 442 records where both exist they agree 438 times, and all four disagreements have the
//      sibling narrower and correct (uuid GHSA-w5hq-g745-h8pq: sibling excludes the patched 11.1.1 /
//      12.0.1 / 13.0.1, prose sweeps in everything below 14.0.0).
//   2. prose — already applied by the normalizer; a row still marked 'prose' here simply keeps it.
//   3. osv — the local OSV cache, and ONLY when the operator has the OSV source enabled. Injected as a
//      lookup so this module never opens or depends on the OSV cache itself; when OSV is off the tier
//      silently does not run and the record falls through to the drop.
//   4. drop — no tier could establish an affected set, so the row is deleted rather than guessed at.

// Ranges for one advisory from the OSV cache, or null when OSV has nothing usable. The worker binds this
// to the live OSV cache only when the source is enabled; omitted entirely otherwise.
export type OsvRangeLookup = (ecosystem: string, packageName: string, ids: string[]) => GemnasiumRange[] | null

export type GemnasiumResolveDeps = {
    osvRanges?: OsvRangeLookup
}

export type GemnasiumResolveResult = {
    considered: number
    fromSibling: number
    fromProse: number
    fromOsv: number
    dropped: number
}

export function resolveGemnasiumRanges(db: GemnasiumDrizzleDb, deps: GemnasiumResolveDeps = {}): GemnasiumResolveResult {
    const pending = listGemnasiumRowsNeedingRanges(db)
    const result: GemnasiumResolveResult = { considered: pending.length, fromSibling: 0, fromProse: 0, fromOsv: 0, dropped: 0 }
    if (pending.length === 0) return result

    const resolutions: GemnasiumRangeResolution[] = []
    const dropKeys: string[] = []
    // One query per (ecosystem, package) rather than per row — a package like parse-server or vite has
    // several stubs pointing at the same set of sibling candidates.
    const siblingCache = new Map<string, GemnasiumAdvisoryRow[]>()

    for (const row of pending) {
        const rowKey = gemnasiumRowKeyFor(row.advisoryId, row.ecosystem, row.packageName)
        const cacheKey = row.ecosystem + '|' + row.packageName
        let candidates = siblingCache.get(cacheKey)
        if (!candidates) {
            candidates = listGemnasiumSiblingCandidates(db, row.ecosystem, row.packageName)
            siblingCache.set(cacheKey, candidates)
        }
        const sibling = pickSibling(row, candidates)
        if (sibling) {
            resolutions.push({ rowKey, ranges: sibling, rangeSource: 'sibling' })
            result.fromSibling++
            continue
        }
        if (row.rangeSource === 'prose' && row.ranges.length > 0) {
            // Already carries usable prose-derived ranges and no sibling improved on them — leave as is.
            result.fromProse++
            continue
        }
        const fromOsv = deps.osvRanges && deps.osvRanges(row.ecosystem, row.packageName, identifiersFor(row)) || null
        if (fromOsv && fromOsv.length > 0) {
            resolutions.push({ rowKey, ranges: fromOsv, rangeSource: 'osv' })
            result.fromOsv++
            continue
        }
        dropKeys.push(rowKey)
    }

    applyGemnasiumRangeResolutions(db, resolutions)
    result.dropped = deleteGemnasiumRowsByKey(db, dropKeys)
    return result
}

// The sibling is the advisory for the same package that cross-references this row's id. The link is
// checked in BOTH directions because gemnasium keys a file by whichever identifier it considers primary:
// the CVE-keyed record lists the GHSA in `identifiers` (so the GHSA stub is found via the sibling's
// aliases), but the reverse pairing also occurs.
//
// A candidate carrying no ranges is skipped — it would "resolve" the row to an empty affected set, which
// is indistinguishable from the sentinel we are trying to escape. When several candidates match, the one
// with the most intervals wins: a multi-branch range is the more completely curated record, and it is
// exactly the branch structure the stub is missing.
function pickSibling(row: GemnasiumAdvisoryRow, candidates: GemnasiumAdvisoryRow[]): GemnasiumRange[] | null {
    const ids = new Set(identifiersFor(row))
    let best: GemnasiumAdvisoryRow | null = null
    for (const candidate of candidates) {
        if (candidate.advisoryId === row.advisoryId) continue
        if (candidate.ranges.length === 0) continue
        const linked = candidate.aliases.some(function pointsAtRow(alias) {
            return ids.has(alias)
        }) || ids.has(candidate.advisoryId)
        if (!linked) continue
        if (!best || candidate.ranges.length > best.ranges.length) best = candidate
    }
    return best && best.ranges || null
}

function identifiersFor(row: GemnasiumAdvisoryRow): string[] {
    return [row.advisoryId, ...row.aliases]
}
