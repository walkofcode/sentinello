// The single implementation of version and range semantics. Everything that needs to know what `>` means,
// how two versions order, or how a range renders back to text imports it from here.
//
// It exists because those answers used to be re-derived in a dozen places and had drifted apart: `>` was
// exclusive in the fix picker and inclusive in the gemnasium normalizer, one range formatter honoured an
// inclusive upper bound while its neighbour ten lines away dropped it, and the version normalizer the
// matcher ran had none of the range-syntax guard that a sibling module documented as necessary. Each copy
// was individually reasonable; together they disagreed, and the disagreements were invisible.
export type { VersionRange, FormatOptions } from './range'
export { formatRange, formatRanges, isZeroVersion } from './range'
export { parseVersionRanges } from './parse'
export { versionInRange } from './match'
export { compareVersions, highestVersion } from './compare'
export type { VersionComparator } from './comparator'
export { semverComparator, normalizeSemver } from './comparators/semver'
export { pep440Comparator, parsePep440 } from './comparators/pep440'
