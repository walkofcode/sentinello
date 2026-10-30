import { describe, expect, it } from 'vitest'
import { comparatorById } from './index'
import { goComparator } from './go'
import { pep440Comparator } from './pep440'
import { rubygemsComparator } from './rubygems'
import { semverComparator } from './semver'

describe('comparatorById', function () {
    it.each([
        ['semver', semverComparator],
        ['pep440', pep440Comparator],
        ['go', goComparator],
        ['rubygems', rubygemsComparator]
    ] as const)('resolves %s to the comparator that carries that id', function (id, comparator) {
        expect(comparatorById(id)).toBe(comparator)
        expect(comparator.id).toBe(id)
    })
})
