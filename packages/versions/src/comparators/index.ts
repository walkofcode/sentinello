import type { ComparatorId, VersionComparator } from '../comparator'
import { goComparator } from './go'
import { pep440Comparator } from './pep440'
import { rubygemsComparator } from './rubygems'
import { semverComparator } from './semver'

// Every comparator, by the id the ecosystem registry names. A Record over the closed id union, so adding
// an id without its implementation does not compile.
const COMPARATORS: Record<ComparatorId, VersionComparator> = {
    semver: semverComparator,
    pep440: pep440Comparator,
    go: goComparator,
    rubygems: rubygemsComparator
}

export function comparatorById(id: ComparatorId): VersionComparator {
    return COMPARATORS[id]
}
