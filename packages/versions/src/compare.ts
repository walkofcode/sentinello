import type { VersionComparator } from './comparator'

// Order two version strings for display — sorting a version list, picking the highest of several — under
// the ecosystem's own comparator.
//
// This exists because the portal had three hand-rolled versions of it that disagreed with each other:
// one compared `split('.')` segments and ignored prereleases entirely (so `1.0.0-rc1` sorted EQUAL to
// `1.0.0`), one stripped a `v`/`=` prefix and ordered prereleases with `localeCompare` (which puts `rc.10`
// before `rc.2`), and one dropped the prerelease before comparing. Each carried a comment explaining that
// pulling in semver was not worth it for a twenty-line problem; together they were sixty lines that gave
// three different answers, and the version chain shown next to a finding depends on which one ran.
//
// The comparator is a REQUIRED argument. This function used to be semver-only, which is how a Django 4.2
// advisory came to recommend 3.2.x: PEP 440's `4.2` and `3.2.23` happened to order the wrong way once
// coerced into semver triples, and nothing at the call site said which ordering it was asking for.
//
// Total and never throws. A value the comparator cannot read sorts BELOW every value it can, then
// lexicographically against its unreadable peers — so a list containing one has a stable order rather than
// a render-dependent one, and `highestVersion` never picks a string it could not parse. That direction is
// load-bearing: this also chooses the "upgrade to" version shown beside a finding, and sorting the
// unreadable end high would recommend "4.17.x" over the real 4.17.21.
export function compareVersions(a: string, b: string, comparator: VersionComparator): number {
    const left = comparator.normalize(a)
    const right = comparator.normalize(b)
    if (left === null || right === null) {
        if (left === null && right === null) return a < b ? -1 : a > b ? 1 : 0
        return left === null ? -1 : 1
    }
    return Math.sign(comparator.compare(left, right))
}

// The highest of a list, or null when the list is empty.
export function highestVersion(versions: readonly string[], comparator: VersionComparator): string | null {
    let best: string | null = null
    for (const candidate of versions) {
        if (best === null || compareVersions(candidate, best, comparator) > 0) best = candidate
    }
    return best
}
