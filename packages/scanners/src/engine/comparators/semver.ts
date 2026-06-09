import { coerce, gte as semverGte, lt as semverLt, valid } from 'semver'
import type { VersionComparator } from '../types'

// The npm-ecosystem version comparator: strict semver first, then a lenient coerce (so "v1.2.3" and
// loose tags still resolve). gte/lt assume their inputs were already normalized by the caller.
export const semverComparator: VersionComparator = {
    normalize(raw: string): string | null {
        const strict = valid(raw)
        if (strict !== null) return strict
        const coerced = coerce(raw)
        return coerced === null ? null : coerced.version
    },
    gte(a: string, b: string): boolean {
        return semverGte(a, b)
    },
    lt(a: string, b: string): boolean {
        return semverLt(a, b)
    }
}
