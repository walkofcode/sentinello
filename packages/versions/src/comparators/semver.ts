import { coerce, compare as semverCompare, prerelease, valid } from 'semver'
import { orderingsFrom, type VersionComparator } from '../comparator'

// Range syntax whose coerced value would NOT mean what the string means. Checked BEFORE coerce(), because
// coerce is happy to read an operator off the front and return the number behind it — '<4.17.21' becomes
// 4.17.21, which is the first FIXED version, the exact opposite of what is installed.
//
// `=` is deliberately absent. Every operator listed here names a version OTHER than the one written after
// it (or a whole span of them), so coercing throws the meaning away; `=1.2.3` names exactly 1.2.3, so
// coercing it is lossless. That distinction is the guard's actual rule, and it is why this is one function
// rather than two: the check previously existed only inside lockfile-cross-check.ts, so the comparator the
// matcher itself runs — this one — coerced range syntax into a concrete version without complaint.
const MEANING_CHANGING_RANGE_SYNTAX = /[<>^~|*]|\s-\s|(^|\.)[xX](\.|$)/

// Strict semver first, then a lenient coerce (so "v1.2.3", "1.2" and other tag-shaped versions that name a
// real release still resolve). Null means "cannot reason about this", never a guess: a string that coerced
// to 0.0.0 would sort below every real release and match every range.
export function normalizeSemver(raw: string): string | null {
    const strict = valid(raw)
    if (strict !== null) return strict
    if (MEANING_CHANGING_RANGE_SYNTAX.test(raw)) return null
    const coerced = coerce(raw)
    return coerced === null ? null : coerced.version
}

// The npm and crates.io version comparator. The ordering functions assume already-normalized inputs.
export const semverComparator: VersionComparator = {
    id: 'semver',
    normalize(raw: string): string | null {
        return normalizeSemver(raw)
    },
    compare: semverCompare,
    ...orderingsFrom(semverCompare),
    releaseKind(version: string) {
        return prerelease(version) === null ? 'release' : 'prerelease'
    }
}
