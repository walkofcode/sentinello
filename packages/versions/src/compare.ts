import { gt as semverGt, lt as semverLt } from 'semver'
import { normalizeSemver } from './comparators/semver'

// Order two version strings for display — sorting a version list, picking the highest of several.
//
// This exists because the portal had three hand-rolled versions of it that disagreed with each other:
// one compared `split('.')` segments and ignored prereleases entirely (so `1.0.0-rc1` sorted EQUAL to
// `1.0.0`), one stripped a `v`/`=` prefix and ordered prereleases with `localeCompare` (which puts `rc.10`
// before `rc.2`), and one dropped the prerelease before comparing. Each carried a comment explaining that
// pulling in semver was not worth it for a twenty-line problem; together they were sixty lines that gave
// three different answers, and the version chain shown next to a finding depends on which one ran.
//
// Total and never throws. A value semver cannot read sorts BELOW every value it can, then
// lexicographically against its unreadable peers — so a list containing one has a stable order rather than
// a render-dependent one, and `highestVersion` never picks a string it could not parse. That direction is
// load-bearing: this also chooses the "upgrade to" version shown beside a finding, and sorting the
// unreadable end high would recommend "4.17.x" over the real 4.17.21.
export function compareVersions(a: string, b: string): number {
    const left = normalizeSemver(a)
    const right = normalizeSemver(b)
    if (left === null || right === null) {
        if (left === null && right === null) return a < b ? -1 : a > b ? 1 : 0
        return left === null ? -1 : 1
    }
    if (semverLt(left, right)) return -1
    if (semverGt(left, right)) return 1
    return 0
}

// The highest of a list, or null when the list is empty.
export function highestVersion(versions: readonly string[]): string | null {
    let best: string | null = null
    for (const candidate of versions) {
        if (best === null || compareVersions(candidate, best) > 0) best = candidate
    }
    return best
}
