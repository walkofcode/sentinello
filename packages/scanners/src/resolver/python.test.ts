import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizePyName, parsePythonLock } from './python'
import type { ResolverResult } from './types'

// Python is the ecosystem where "how much did we actually audit" is hardest to state honestly:
// poetry/uv/Pipfile lockfiles pin exact versions, but requirements.txt is a free-form install list. The
// status returned is therefore load-bearing — `ok` claims full coverage, `partial` discloses the
// unaudited remainder — so nearly every case below asserts the status, not just the package list.

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-python-'))
})

afterEach(async function cleanup() {
    await rm(dir, { recursive: true, force: true })
})

async function write(name: string, text: string): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, text, 'utf8')
    return path
}

function names(result: ResolverResult): string[] {
    if (result.status === 'unauditable') return []
    return result.graph.packages.map(function name(p) {
        return p.name
    })
}

async function parse(kind: string, text: string): Promise<ResolverResult> {
    return await parsePythonLock(kind, await write(kind, text))
}

describe('normalizePyName', function () {
    // PEP 503 canonical form — lower case with runs of -_. collapsed to a single dash. OSV keys PyPI
    // advisories this way, so a normalization miss means the advisory never matches.
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

describe('parsePythonLock dispatch', function () {
    it('is unauditable when the file cannot be read', async function () {
        const result = await parsePythonLock('poetry.lock', join(dir, 'nope.lock'))
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('unsupported_lockfile')
    })

    it('is unauditable for an unsupported manifest kind', async function () {
        const result = await parse('setup.py', 'whatever')
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.details.join(' ')).toContain('setup.py')
    })

    it('always reports the PyPI ecosystem', async function () {
        const result = await parse('poetry.lock', '[[package]]\nname = "a"\nversion = "1.0"\n')
        expect(result.ecosystem).toBe('PyPI')
    })
})

describe('parsePythonLock poetry.lock', function () {
    const POETRY = `[[package]]
name = "Django"
version = "4.2.0"
category = "main"

[[package]]
name = "pytest"
version = "7.0.0"
category = "dev"
`

    it('resolves to an ok graph because versions are pinned', async function () {
        const result = await parse('poetry.lock', POETRY)
        expect(result.status).toBe('ok')
    })

    it('normalizes package names', async function () {
        expect(names(await parse('poetry.lock', POETRY)).sort()).toEqual(['django', 'pytest'])
    })

    it('splits prod and dev by the category field', async function () {
        const result = await parse('poetry.lock', POETRY)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('django', '4.2.0')).toMatchObject({ isProd: true, isDev: false })
        expect(result.graph.classify('pytest', '7.0.0')).toMatchObject({ isProd: false, isDev: true })
    })

    it('marks an optional package optional', async function () {
        const text = '[[package]]\nname = "a"\nversion = "1.0"\noptional = true\n'
        const result = await parse('poetry.lock', text)
        expect(result.status !== 'unauditable' && result.graph.byName('a')[0]?.scope.isOptional).toBe(true)
    })

    it('skips an entry missing a name or version', async function () {
        const text = '[[package]]\nname = "a"\n\n[[package]]\nname = "b"\nversion = "1.0"\n'
        expect(names(await parse('poetry.lock', text))).toEqual(['b'])
    })

    it('is unauditable when no packages are found', async function () {
        const result = await parse('poetry.lock', '# empty\n')
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('ambiguous_dependency_spec')
    })
})

describe('parsePythonLock uv.lock', function () {
    // uv.lock carries no dependency-group information, so everything is prod rather than guessed.
    it('treats every package as prod because uv records no scope', async function () {
        const text = '[[package]]\nname = "a"\nversion = "1.0"\ncategory = "dev"\n'
        const result = await parse('uv.lock', text)
        expect(result.status).toBe('ok')
        expect(result.status !== 'unauditable' && result.graph.classify('a', '1.0')).toMatchObject({
            isProd: true,
            isDev: false
        })
    })
})

describe('parsePythonLock Pipfile.lock', function () {
    it('reads default as prod and develop as dev', async function () {
        const text = JSON.stringify({
            default: { django: { version: '==4.2.0' } },
            develop: { pytest: { version: '==7.0.0' } }
        })
        const result = await parse('Pipfile.lock', text)
        expect(result.status).toBe('ok')
        if (result.status === 'unauditable') return
        expect(result.graph.classify('django', '4.2.0')).toMatchObject({ isProd: true, isDev: false })
        expect(result.graph.classify('pytest', '7.0.0')).toMatchObject({ isProd: false, isDev: true })
    })

    it('strips the == pin from the version', async function () {
        const text = JSON.stringify({ default: { a: { version: '==1.0.0' } } })
        const result = await parse('Pipfile.lock', text)
        expect(result.status !== 'unauditable' && result.graph.byName('a')[0]?.version).toBe('1.0.0')
    })

    it('accepts the arbitrary-equality === pin', async function () {
        const text = JSON.stringify({ default: { a: { version: '===1.0.0' } } })
        const result = await parse('Pipfile.lock', text)
        expect(result.status !== 'unauditable' && result.graph.byName('a')[0]?.version).toBe('1.0.0')
    })

    // An unpinned entry cannot be audited, so it must both be excluded AND downgrade the status.
    it('reports partial when an entry is not pinned', async function () {
        const text = JSON.stringify({ default: { a: { version: '==1.0.0' }, b: { version: '*' } } })
        const result = await parse('Pipfile.lock', text)
        expect(result.status).toBe('partial')
        expect(names(result)).toEqual(['a'])
        expect(result.status === 'partial' && result.details.join(' ')).toContain('1 Pipfile.lock')
    })

    // `develop` gets its own ambiguity callback, separate from `default`'s. Exercising only the
    // default group leaves the dev-side counter unproven — a swapped or dropped argument in the
    // second collectPipfileGroup call would still pass every test above.
    it('reports partial when a develop entry is not pinned', async function () {
        const text = JSON.stringify({
            default: { a: { version: '==1.0.0' } },
            develop: { b: { version: '*' } }
        })
        const result = await parse('Pipfile.lock', text)
        expect(result.status).toBe('partial')
        expect(names(result)).toEqual(['a'])
        expect(result.status === 'partial' && result.details.join(' ')).toContain('1 Pipfile.lock')
    })

    it.each(['==1.2.*', '>=1.0', '', '~=1.0', '===', '=='])('treats the version %j as unpinned', async function (version) {
        const text = JSON.stringify({ default: { a: { version: '==1.0.0' }, b: { version } } })
        expect(names(await parse('Pipfile.lock', text))).toEqual(['a'])
    })

    // pipenv writes a bare entry for a package it resolved but did not pin. There is no version
    // string to read at all, which is a different shape from a version string that fails to parse.
    it.each([null, {}, { version: 42 }] as unknown[])('treats the entry %j as unpinned', async function (entry) {
        const text = JSON.stringify({ default: { a: { version: '==1.0.0' }, b: entry } })
        expect(names(await parse('Pipfile.lock', text))).toEqual(['a'])
    })

    it('is unauditable on invalid JSON', async function () {
        const result = await parse('Pipfile.lock', '{ broken')
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('unsupported_lockfile')
    })

    it.each(['null', '42', '"a string"'])('is unauditable for the non-object document %s', async function (raw) {
        expect((await parse('Pipfile.lock', raw)).status).toBe('unauditable')
    })

    it('is unauditable when nothing is pinned', async function () {
        const result = await parse('Pipfile.lock', JSON.stringify({ default: { a: { version: '*' } } }))
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('ambiguous_dependency_spec')
    })
})

describe('parsePythonLock requirements.txt', function () {
    it('resolves to ok when every line is an exact pin', async function () {
        const result = await parse('requirements.txt', 'django==4.2.0\nrequests==2.31.0\n')
        expect(result.status).toBe('ok')
        expect(names(result)).toEqual(['django', 'requests'])
    })

    it('ignores comments and blank lines', async function () {
        const result = await parse('requirements.txt', '# a note\n\ndjango==4.2.0  # inline\n')
        expect(result.status).toBe('ok')
        expect(names(result)).toEqual(['django'])
    })

    it('strips extras from the package name', async function () {
        const result = await parse('requirements.txt', 'requests[security]==2.31.0\n')
        expect(names(result)).toEqual(['requests'])
    })

    it('accepts the arbitrary-equality === pin', async function () {
        const result = await parse('requirements.txt', 'a===1.0.0\n')
        expect(result.status !== 'unauditable' && result.graph.byName('a')[0]?.version).toBe('1.0.0')
    })

    // Everything that is not an exact pin has to downgrade the status, or the scan would silently
    // claim to have audited lines it skipped.
    it.each([
        ['django>=4.0', 'a range'],
        ['django', 'a bare name'],
        ['django~=4.0', 'a compatible-release spec'],
        ['django!=4.0', 'an exclusion'],
        ['django==4.2.*', 'a wildcard pin'],
        ['-r other.txt', 'an include'],
        ['-e .', 'an editable'],
        ['--hash=sha256:abc', 'an option']
    ] as Array<[string, string]>)('reports partial for %s (%s)', async function (line) {
        const result = await parse('requirements.txt', 'pinned==1.0.0\n' + line + '\n')
        expect(result.status).toBe('partial')
        expect(names(result)).toEqual(['pinned'])
    })

    // A marker-gated pin IS audited (conservatively), but still flags partial because we cannot
    // evaluate the marker offline.
    it('audits a marker-gated pin but still reports partial', async function () {
        const result = await parse('requirements.txt', 'django==4.2.0; python_version < "3.12"\n')
        expect(result.status).toBe('partial')
        expect(names(result)).toEqual(['django'])
    })

    it('counts every skipped line in the disclosure', async function () {
        const result = await parse('requirements.txt', 'a==1.0.0\nb>=1\nc\n-r x.txt\n')
        expect(result.status === 'partial' && result.details.join(' ')).toContain('3 requirements.txt lines')
    })

    it('treats every package as prod because requirements.txt has no scope', async function () {
        const result = await parse('requirements.txt', 'a==1.0.0\n')
        expect(result.status !== 'unauditable' && result.graph.classify('a', '1.0.0')).toMatchObject({
            isProd: true,
            isDev: false
        })
    })

    it('rejects a name with characters PEP 508 does not allow', async function () {
        const result = await parse('requirements.txt', 'a==1.0.0\nbad name!==1.0\n')
        expect(names(result)).toEqual(['a'])
    })

    it('handles CRLF line endings', async function () {
        expect(names(await parse('requirements.txt', 'a==1.0.0\r\nb==2.0.0\r\n'))).toEqual(['a', 'b'])
    })

    it('is unauditable when nothing is pinned', async function () {
        const result = await parse('requirements.txt', 'django>=4.0\nrequests\n')
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.details.join(' ')).toContain('no exact (==) version pins')
    })
})
