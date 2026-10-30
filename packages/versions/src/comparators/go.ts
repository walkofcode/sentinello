import { compare as semverCompare, prerelease, valid } from 'semver'
import { orderingsFrom, type VersionComparator } from '../comparator'

// The Go module version comparator (https://go.dev/ref/mod#versions).
//
// A Go version IS a semantic version with a mandatory `v`, so the ordering is semver's — but three things
// differ from npm's reading, and each one used to be handled by the semver comparator's leniency, which is
// exactly wrong for Go:
//
//   - NO COERCION. npm's comparator coerces "1.2" to 1.2.0 so tag-shaped strings still resolve; Go has no
//     partial versions at all, and a module path's major suffix (`/v2`) is part of the NAME, never a
//     version. Coercing would read garbage as a release.
//   - PSEUDO-VERSIONS (`v0.0.0-20180523222229-09b5706aa936`, `vX.Y.Z-pre.0.<time>-<rev>`,
//     `vX.Y.(Z+1)-0.<time>-<rev>`) are semver prereleases by construction, and the Go toolchain orders them
//     by plain semver precedence. They are commits, not tags, so releaseKind reports them apart.
//   - `+incompatible` marks a v2+ module without a go.mod. It is build metadata, which semver precedence
//     ignores — and so does Go's ordering.
//
// The `v` is optional on input: OSV states Go ranges without it, gemnasium mostly with it, and go.mod
// always with it. Normalized values carry none.
export function normalizeGo(raw: string): string | null {
    const trimmed = raw.trim()
    const bare = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed
    return valid(bare)
}

// module.IsPseudoVersion, applied to a `v`-less normalized value. Build metadata is already gone.
const PSEUDO_VERSION = /^[0-9]+\.(0\.0-|\d+\.\d+-([^+]*\.)?0\.)\d{14}-[A-Za-z0-9]+$/

export const goComparator: VersionComparator = {
    id: 'go',
    normalize: normalizeGo,
    compare: semverCompare,
    ...orderingsFrom(semverCompare),
    releaseKind(version: string) {
        if (prerelease(version) === null) return 'release'
        return PSEUDO_VERSION.test(version) ? 'pseudo' : 'prerelease'
    }
}
