import { describe, expect, it } from 'vitest'
import { normalizePyName } from './names'

// PEP 503 canonical form — lower case with runs of -_. collapsed to a single dash. OSV, gemnasium and the
// resolver all key PyPI names this way, so a normalization miss means the advisory never matches.
describe('normalizePyName', function () {
    it.each([
        ['Django', 'django'],
        ['zope.interface', 'zope-interface'],
        ['ruamel_yaml', 'ruamel-yaml'],
        ['Flask--SQLAlchemy', 'flask-sqlalchemy'],
        ['a._-.b', 'a-b'],
        ['  Requests  ', 'requests']
    ] as Array<[string, string]>)('normalizes %j to %j', function (raw, expected) {
        expect(normalizePyName(raw)).toBe(expected)
    })
})
