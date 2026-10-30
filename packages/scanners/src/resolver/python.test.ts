import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePythonLock } from './python'
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
    return await parsePythonLock(dir, kind, await write(kind, text), kind)
}

describe('parsePythonLock dispatch', function () {
    it('is unauditable when the file cannot be read', async function () {
        const result = await parsePythonLock(dir, 'poetry.lock', join(dir, 'nope.lock'), 'nope.lock')
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
    // A uv workspace member is the project itself (`editable`/`virtual`), never a dependency to audit; its
    // dependencies are the prod roots, its optional dependencies optional, its dev groups dev.
    const UV = `version = 1
requires-python = ">=3.12"

[[package]]
name = "my-app"
version = "0.1.0"
source = { editable = "." }
dependencies = [
    { name = "Requests" },
]

[package.optional-dependencies]
socks = [
    { name = "pysocks" },
]

[package.dev-dependencies]
dev = [
    { name = "pytest" },
]

[[package]]
name = "requests"
version = "2.32.3"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "certifi" },
]

[[package]]
name = "certifi"
version = "2024.8.30"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pysocks"
version = "1.7.1"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "pytest"
version = "8.3.3"
source = { registry = "https://pypi.org/simple" }
dependencies = [
    { name = "iniconfig" },
]

[[package]]
name = "iniconfig"
version = "2.0.0"
source = { registry = "https://pypi.org/simple" }
`

    it('does not audit the workspace member itself', async function () {
        const result = await parse('uv.lock', UV)
        expect(result.status).toBe('ok')
        expect(names(result).sort()).toEqual(['certifi', 'iniconfig', 'pysocks', 'pytest', 'requests'])
    })

    it('scopes by reachability from the member', async function () {
        const result = await parse('uv.lock', UV)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('certifi', '2024.8.30')).toMatchObject({ isProd: true, isDev: false })
        expect(result.graph.classify('iniconfig', '2.0.0')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('pysocks', '1.7.1')).toMatchObject({ isProd: true, isOptional: true })
    })

    it('gives each package its chain from the project', async function () {
        const result = await parse('uv.lock', UV)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.byName('certifi')[0]?.depPaths).toEqual(['requests@2.32.3', 'certifi@2024.8.30'])
        expect(result.graph.byName('certifi')[0]?.manifestPath).toBe('uv.lock')
    })

    // A git or URL source is not the index release of that name.
    it('counts a git, URL or outside-path package as cannot be audited', async function () {
        const text = UV + '\n[[package]]\nname = "forked"\nversion = "1.0"\nsource = { git = "https://example.test/forked.git?rev=abc#abc" }\n'
            + '\n[[package]]\nname = "wheel-url"\nversion = "1.0"\nsource = { url = "https://example.test/x.whl" }\n'
            + '\n[[package]]\nname = "sibling"\nversion = "1.0"\nsource = { directory = "../sibling" }\n'
        const result = await parse('uv.lock', text)
        expect(result.status).toBe('partial')
        expect(result.status === 'partial' && result.details.join(' ')).toContain('forked (git), sibling (path), wheel-url (url)')
        expect(names(result)).not.toContain('forked')
    })

    // A lock with no member to start from still has a graph: whatever nothing depends on is a root.
    it('treats every package nothing depends on as a prod root without a member', async function () {
        const text = '[[package]]\nname = "a"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple" }\ndependencies = [\n    { name = "b", version = "2.0" },\n]\n\n[[package]]\nname = "b"\nversion = "2.0"\n'
        const result = await parse('uv.lock', text)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.byName('b')[0]?.depPaths).toEqual(['a@1.0', 'b@2.0'])
        expect(result.graph.classify('b', '2.0')).toMatchObject({ isProd: true, isDev: false })
    })

    it('is unauditable when only the member is locked', async function () {
        const result = await parse('uv.lock', '[[package]]\nname = "my-app"\nsource = { virtual = "." }\n')
        expect(result.status).toBe('unauditable')
    })
})

describe('parsePythonLock poetry.lock graph', function () {
    const LOCK = `[[package]]
name = "Django"
version = "4.2.11"
optional = false

[package.dependencies]
asgiref = ">=3.6.0,<4"

[[package]]
name = "asgiref"
version = "3.8.1"

[[package]]
name = "pytest"
version = "8.3.3"

[package.dependencies]
pluggy = ">=1.5,<2"

[[package]]
name = "pluggy"
version = "1.5.0"

[[package]]
name = "redis"
version = "5.0.0"

[[package]]
name = "my-lib"
version = "0.2.0"

[package.source]
type = "directory"
url = "libs/my-lib"

[[package]]
name = "forked"
version = "1.0.0"

[package.source]
type = "git"
url = "https://example.test/forked.git"
`

    // The project is not in poetry.lock; pyproject.toml names its direct dependencies and their groups.
    it('takes its roots and their groups from pyproject.toml', async function () {
        await write('pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.11"\ndjango = "^4.2"\nredis = { version = "^5", optional = true }\nmy-lib = { path = "libs/my-lib" }\n\n[tool.poetry.group.test.dependencies]\npytest = "^8"\n')
        const result = await parse('poetry.lock', LOCK)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('asgiref', '3.8.1')).toMatchObject({ isProd: true, isDev: false })
        expect(result.graph.classify('pluggy', '1.5.0')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('redis', '5.0.0')).toMatchObject({ isProd: true, isOptional: true })
        expect(result.graph.byName('asgiref')[0]?.depPaths).toEqual(['django@4.2.11', 'asgiref@3.8.1'])
    })

    it('reads PEP 621 and PEP 735 declarations', async function () {
        await write('pyproject.toml', '[project]\nname = "app"\ndependencies = [\n  "Django>=4.2",\n  "redis[hiredis] ; python_version > \'3\'",\n]\n\n[project.optional-dependencies]\ncache = ["redis"]\n\n[dependency-groups]\ntest = ["pytest>=8", { include-group = "lint" }]\n')
        const result = await parse('poetry.lock', LOCK)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('redis', '5.0.0')).toMatchObject({ isProd: true, isOptional: false })
        expect(result.graph.classify('pluggy', '1.5.0')).toMatchObject({ isProd: false, isDev: true })
    })

    it('reads the legacy dev-dependencies table as dev', async function () {
        await write('pyproject.toml', '[tool.poetry.dev-dependencies]\npytest = "^8"\n')
        const result = await parse('poetry.lock', LOCK)
        expect(result.status !== 'unauditable' && result.graph.classify('pluggy', '1.5.0')).toMatchObject({ isProd: false, isDev: true })
    })

    // A path dependency inside the project is its own code; a git one is counted, never matched.
    it('separates own code from what cannot be audited', async function () {
        const result = await parse('poetry.lock', LOCK)
        expect(result.status).toBe('partial')
        expect(names(result)).not.toContain('my-lib')
        expect(names(result)).not.toContain('forked')
        expect(result.status === 'partial' && result.details).toEqual(['1 packages from git, URL or local sources cannot be audited: forked (git)'])
    })

    it('falls back to the packages nothing depends on when pyproject.toml declares nothing', async function () {
        await write('pyproject.toml', '[build-system]\nrequires = ["poetry-core"]\n')
        const result = await parse('poetry.lock', LOCK)
        expect(result.status !== 'unauditable' && result.graph.byName('pluggy')[0]?.depPaths).toEqual(['pytest@8.3.3', 'pluggy@1.5.0'])
    })

    it.each([['url', 'https://example.test/x.whl', 'x (url)'], ['file', '../x.tar.gz', 'x (path)']])('counts a %s source', async function (type, url, expected) {
        const result = await parse('poetry.lock', '[[package]]\nname = "x"\nversion = "1.0"\n\n[package.source]\ntype = "' + type + '"\nurl = "' + url + '"\n\n[[package]]\nname = "a"\nversion = "1.0"\n')
        expect(result.status === 'partial' && result.details.join(' ')).toContain(expected)
    })

    // A private index is still an index of PyPI packages.
    it('audits a package from a legacy (private index) source', async function () {
        const result = await parse('poetry.lock', '[[package]]\nname = "a"\nversion = "1.0"\n\n[package.source]\ntype = "legacy"\nurl = "https://pypi.example.test/simple"\n')
        expect(result.status).toBe('ok')
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

describe('parsePythonLock — entries it does not model', function () {
    // A directory source with no path cannot be placed inside the project, so it is not own code.
    it('counts a poetry directory source with no url as a local path', async function () {
        const result = await parse('poetry.lock', '[[package]]\nname = "x"\nversion = "1.0"\n\n[package.source]\ntype = "directory"\n\n[[package]]\nname = "a"\nversion = "1.0"\n')
        expect(result.status === 'partial' && result.details.join(' ')).toContain('x (path)')
    })

    // A source table with no type names no other origin, so the package came from the index.
    it('audits a poetry package whose source table has no type', async function () {
        expect((await parse('poetry.lock', '[[package]]\nname = "a"\nversion = "1.0"\n\n[package.source]\nreference = "main"\n')).status).toBe('ok')
    })

    it('skips what a uv.lock lists in shapes it does not lock', async function () {
        const text = '[[package]]\nversion = "1.0"\n\n'
            + '[[package]]\nname = "app"\nsource = { virtual = "." }\ndependencies = [\n    { name = "missing" },\n    "not-a-table",\n    { version = "1.0" },\n    { name = "a", version = "1.0" },\n]\n\n'
            + '[[package]]\nname = "a"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple" }\ndependencies = [{ name = "gone" }]\n\n'
            + '[[package]]\nname = "local-wheel"\nversion = "1.0"\nsource = { path = "../dist/local.whl" }\n\n'
            + '[[package]]\nname = "unknown-source"\nversion = "1.0"\nsource = { }\n'
        const result = await parse('uv.lock', text)
        expect(names(result)).toEqual(['a'])
        expect(result.status === 'partial' && result.details.join(' ')).toContain('local-wheel (path), unknown-source (path)')
        // Only the edge to a locked package survives; `missing` and `gone` lead nowhere.
        expect(result.status !== 'unauditable' && result.graph.nodeGraph?.edges).toEqual([{ from: 'app@ (virtual=.)', to: 'a@1.0 (registry=https://pypi.org/simple)', kind: 'prod' }])
    })

    it('is unauditable, naming them, when everything comes from git', async function () {
        const result = await parse('uv.lock', '[[package]]\nname = "x"\nversion = "1.0"\nsource = { git = "https://example.test/x.git" }\n')
        expect(result).toMatchObject({ status: 'unauditable', details: ['1 packages from git, URL or local sources cannot be audited: x (git)'] })
    })

    // A name declared more than one way keeps the widest scope: prod over optional over dev.
    it('keeps the widest scope for a name pyproject.toml declares twice', async function () {
        await write('pyproject.toml', '[project]\ndependencies = ["django", "./local-path"]\n\n[project.optional-dependencies]\nx = ["redis", "django"]\n\n[dependency-groups]\ndev = ["redis", "django"]\n')
        const lock = '[[package]]\nname = "django"\nversion = "4.2"\n\n[[package]]\nname = "redis"\nversion = "5.0"\n'
        const result = await parse('poetry.lock', lock)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('django', '4.2')).toMatchObject({ isProd: true, isDev: false, isOptional: false })
        expect(result.graph.classify('redis', '5.0')).toMatchObject({ isProd: true, isDev: false, isOptional: true })
    })
})

// SENTINEL-128: a local wheel or sdist is a built third-party package wherever it sits. Checked into the
// project it is still not the project's own code, so it is counted as cannot-be-audited — never omitted.
describe('parsePythonLock — local artifacts inside the project', function () {
    it('counts a poetry file source inside the project', async function () {
        const lock = '[[package]]\nname = "a"\nversion = "1.0"\n\n'
            + '[[package]]\nname = "vendored-lib"\nversion = "1.0"\n\n[package.source]\ntype = "file"\nurl = "vendor/vendored_lib-1.0-py3-none-any.whl"\n'
        const result = await parse('poetry.lock', lock)
        expect(result.status).toBe('partial')
        expect(names(result)).toEqual(['a'])
        expect(result.status === 'partial' && result.details).toEqual(['1 packages from git, URL or local sources cannot be audited: vendored-lib (path)'])
    })

    it('counts a uv path source inside the project', async function () {
        const lock = '[[package]]\nname = "app"\nsource = { virtual = "." }\ndependencies = [{ name = "a" }, { name = "vendored-lib" }]\n\n'
            + '[[package]]\nname = "a"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple" }\n\n'
            + '[[package]]\nname = "vendored-lib"\nversion = "1.0"\nsource = { path = "vendor/vendored_lib-1.0-py3-none-any.whl" }\n'
        const result = await parse('uv.lock', lock)
        expect(result.status).toBe('partial')
        expect(names(result)).toEqual(['a'])
        expect(result.status === 'partial' && result.details).toEqual(['1 packages from git, URL or local sources cannot be audited: vendored-lib (path)'])
    })

    // A source directory inside the project is still the project's own: a uv directory source, a poetry
    // directory dependency.
    it('keeps an in-project source directory as own code', async function () {
        const lock = '[[package]]\nname = "app"\nsource = { virtual = "." }\ndependencies = [{ name = "a" }, { name = "sibling" }]\n\n'
            + '[[package]]\nname = "a"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple" }\n\n'
            + '[[package]]\nname = "sibling"\nversion = "0.1.0"\nsource = { directory = "libs/sibling" }\n'
        expect((await parse('uv.lock', lock)).status).toBe('ok')
    })
})

// SENTINEL-130: one name at one version from an index and from git are two packages. Only the index one is
// audited, and each keeps its own edges and scope, whichever order the lockfile lists them in.
describe('parsePythonLock — one name and version from two sources', function () {
    const MEMBER = '[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n'
        + 'dependencies = [{ name = "x", version = "1.0", source = { git = "https://example.test/x.git?rev=abc#abc" } }]\n\n'
        + '[package.dev-dependencies]\ndev = [{ name = "y" }]\n\n'
        + '[[package]]\nname = "y"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple" }\n'
        + 'dependencies = [{ name = "x", version = "1.0", source = { registry = "https://pypi.org/simple" } }]\n\n'
    const INDEX_X = '[[package]]\nname = "x"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple" }\ndependencies = [{ name = "a" }]\n\n'
    const GIT_X = '[[package]]\nname = "x"\nversion = "1.0"\nsource = { git = "https://example.test/x.git?rev=abc#abc" }\ndependencies = [{ name = "b" }]\n\n'
    const LEAVES = '[[package]]\nname = "a"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple" }\n\n'
        + '[[package]]\nname = "b"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple" }\n'

    it.each([
        ['index first', MEMBER + INDEX_X + GIT_X + LEAVES],
        ['git first', MEMBER + GIT_X + INDEX_X + LEAVES]
    ])('keeps them apart (%s)', async function (_order, lock) {
        const result = await parse('uv.lock', lock)
        if (result.status !== 'partial') throw new Error('expected a partial graph')
        expect(result.details).toEqual(['1 packages from git, URL or local sources cannot be audited: x (git)'])
        expect(result.graph.byName('x').map(function chain(p) { return p.depPaths.join(' > ') })).toEqual(['y@1.0 > x@1.0'])
        // The index x is reached only through the dev group's y; the git x, which ships, is never audited.
        expect(result.graph.classify('x', '1.0')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('a', '1.0')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('b', '1.0')).toMatchObject({ isProd: true, isDev: false })
    })

    // poetry names a dependency without saying which locked entry it means; every one that could be it is
    // linked, never an arbitrary first.
    it('links a poetry dependency to every locked entry of its name', async function () {
        await write('pyproject.toml', '[project]\ndependencies = ["app-lib"]\n')
        const lock = '[[package]]\nname = "app-lib"\nversion = "1.0"\n\n[package.dependencies]\nnumpy = "*"\n\n'
            + '[[package]]\nname = "numpy"\nversion = "1.26.4"\n\n'
            + '[[package]]\nname = "numpy"\nversion = "2.0.0"\n'
        const result = await parse('poetry.lock', lock)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.byName('numpy').map(function chain(p) { return p.depPaths.join(' > ') }).sort()).toEqual(['app-lib@1.0 > numpy@1.26.4', 'app-lib@1.0 > numpy@2.0.0'])
    })
})
