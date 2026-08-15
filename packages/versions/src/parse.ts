import type { VersionRange } from './range'

// Read ranges back out of a cache's JSON blob.
//
// This is deliberately ONE function rather than one per advisory store. Both stores previously had their
// own copy that rebuilt the range field by field, and a field-by-field rebuild fails in the worst possible
// way: adding a field to the range type compiles everywhere, writes correctly, and is then silently
// discarded on read, with no error and no failing test. The gemnasium copy reconstructed exactly two
// fields, so it would have dropped every bound-inclusivity flag written to it.
//
// Unknown fields are dropped and malformed entries skipped — but every field the type declares is carried.
export function parseVersionRanges(json: string): VersionRange[] {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    const out: VersionRange[] = []
    for (const entry of parsed) {
        const range = toVersionRange(entry)
        if (range !== null) out.push(range)
    }
    return out
}

function toVersionRange(entry: unknown): VersionRange | null {
    if (!entry || typeof entry !== 'object') return null
    const raw = entry as Record<string, unknown>
    const introduced = raw.introduced
    if (typeof introduced !== 'string') return null
    // Both upper bounds are always present as `string | null`; only the two genuinely-optional fields stay
    // absent when unset, so a range round-trips to the same shape it was written as. `type` is absent for
    // gemnasium (which has no such concept) and `introducedExclusive` is a sparse flag — an absent one and
    // an explicit `false` mean the same thing, so only `true` is ever stored.
    const range: VersionRange = {
        introduced,
        fixed: typeof raw.fixed === 'string' ? raw.fixed : null,
        lastAffected: typeof raw.lastAffected === 'string' ? raw.lastAffected : null
    }
    if (typeof raw.type === 'string') range.type = raw.type
    if (raw.introducedExclusive === true) range.introducedExclusive = true
    return range
}
