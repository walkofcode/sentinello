import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseGoMod } from './go'

// Go is resolved offline from go.mod (falling back to go.sum). Whether that is the whole build list is the
// `go` directive's to say: from Go 1.17 a go.mod lists every module its build needs, before it only the
// direct ones. The status is therefore asserted explicitly, never incidentally — `ok` claims completeness.

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-go-'))
})

afterEach(async function cleanup() {
    await rm(dir, { recursive: true, force: true })
})

async function write(name: string, text: string): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, text, 'utf8')
    return path
}

async function parse(kind: string, text: string): Promise<Awaited<ReturnType<typeof parseGoMod>>> {
    return await parseGoMod(kind, await write(kind, text), kind)
}

function names(result: Awaited<ReturnType<typeof parseGoMod>>): string[] {
    if (result.status === 'unauditable') return []
    return result.graph.packages.map(function name(p) {
        return p.name
    })
}

const GO_MOD = `module example.com/app

go 1.22

require (
	github.com/pkg/errors v0.9.1
	golang.org/x/text v0.14.0 // indirect
)

require github.com/spf13/cobra v1.8.0
`

describe('parseGoMod failure handling', function () {
    it('is unauditable when the file cannot be read', async function () {
        const result = await parseGoMod('go.mod', join(dir, 'nope.mod'), 'go.mod')
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('ambiguous_dependency_spec')
    })

    it('is unauditable when no modules are found', async function () {
        const result = await parse('go.mod', 'module example.com/app\n\ngo 1.22\n')
        expect(result.status).toBe('unauditable')
    })

    it('names the file it could not use in the details', async function () {
        const result = await parseGoMod('go.mod', join(dir, 'nope.mod'), 'go.mod')
        expect(result.status === 'unauditable' && result.details.join(' ')).toContain('go.mod')
    })
})

describe('parseGoMod reading go.mod', function () {
    it('reads modules from a require block and a single require', async function () {
        const result = await parse('go.mod', GO_MOD)
        expect(names(result).sort()).toEqual([
            'github.com/pkg/errors',
            'github.com/spf13/cobra',
            'golang.org/x/text'
        ])
    })

    // `go 1.22`: the file is the build list, so nothing is left to disclose.
    it('is ok for a go.mod at Go 1.17 or later', async function () {
        const result = await parse('go.mod', GO_MOD)
        expect(result.status).toBe('ok')
        expect((await parse('go.mod', 'go 1.17.0\nrequire github.com/a/b v1.0.0\n')).status).toBe('ok')
        expect((await parse('go.mod', 'go 2.0\nrequire github.com/a/b v1.0.0\n')).status).toBe('ok')
    })

    // Before 1.17 the indirect modules live in the dependencies' go.mod files, which are not here.
    it.each(['go 1.16\n', 'go 1.9\n', 'go banana\n', ''])('is partial with a disclosure for %j', async function (directive) {
        const result = await parse('go.mod', directive + 'require github.com/a/b v1.0.0\n')
        expect(result.status).toBe('partial')
        expect(result.status === 'partial' && result.reasonCode).toBe('partial_dependency_graph')
        expect(result.status === 'partial' && result.details.join(' ')).toContain('before Go 1.17')
    })

    it('records the manifest each module came from', async function () {
        const result = await parse('go.mod', GO_MOD)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(new Set(result.graph.packages.map(function path(p) { return p.manifestPath }))).toEqual(new Set(['go.mod']))
    })

    // go.mod and go.sum record no dependency graph, so no module carries a chain: every surface reads it as
    // chain unknown rather than show the module alone as if it were one.
    it('gives no module a dependency chain', async function () {
        for (const kind of ['go.mod', 'go.sum']) {
            const result = await parse(kind, kind === 'go.mod' ? GO_MOD : 'example.com/lib v1.0.0 h1:x=\nexample.com/lib v1.0.0/go.mod h1:y=\n')
            if (result.status === 'unauditable') throw new Error('expected a graph')
            expect(result.graph.packages.length).toBeGreaterThan(0)
            expect(result.graph.packages.every(function noChain(p) { return p.depPaths.length === 0 })).toBe(true)
        }
    })

    it('reports the Go ecosystem', async function () {
        const result = await parse('go.mod', GO_MOD)
        expect(result.ecosystem).toBe('Go')
    })

    // Indirect modules are still installed code and can still be vulnerable, so the `// indirect`
    // marker must not exclude them.
    it('includes indirect modules', async function () {
        const result = await parse('go.mod', GO_MOD)
        expect(names(result)).toContain('golang.org/x/text')
    })

    it('keeps the v-prefixed version for the Go comparator', async function () {
        const result = await parse('go.mod', GO_MOD)
        const pkg = result.status !== 'unauditable' && result.graph.byName('github.com/pkg/errors')[0]
        expect(pkg && pkg.version).toBe('v0.9.1')
    })

    // Go has no module-level dev/test scope, so everything is prod.
    it('treats every module as a production dependency', async function () {
        const result = await parse('go.mod', GO_MOD)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        for (const pkg of result.graph.packages) {
            expect(pkg.scope).toEqual({ isProd: true, isDev: false, isOptional: false })
        }
    })

    it('ignores a comment-only line', async function () {
        const text = 'require (\n\t// a note\n\tgithub.com/a/b v1.0.0\n)\n'
        expect(names(await parse('go.mod', text))).toEqual(['github.com/a/b'])
    })

    it('handles CRLF line endings', async function () {
        const text = 'require (\r\n\tgithub.com/a/b v1.0.0\r\n)\r\n'
        expect(names(await parse('go.mod', text))).toEqual(['github.com/a/b'])
    })

    it('deduplicates a module repeated at the same version', async function () {
        const text = 'require (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/a/b v1.0.0\n)\n'
        expect(names(await parse('go.mod', text))).toEqual(['github.com/a/b'])
    })

    it('keeps a module listed at two versions', async function () {
        const text = 'require (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/a/b v2.0.0\n)\n'
        expect(names(await parse('go.mod', text))).toHaveLength(2)
    })

    it('ignores a require entry with no version', async function () {
        const text = 'require (\n\tgithub.com/a/b\n\tgithub.com/c/d v1.0.0\n)\n'
        expect(names(await parse('go.mod', text))).toEqual(['github.com/c/d'])
    })
})

describe('parseGoMod reading go.sum', function () {
    const GO_SUM = `github.com/pkg/errors v0.9.1 h1:abc=
github.com/pkg/errors v0.9.1/go.mod h1:def=
golang.org/x/text v0.14.0 h1:ghi=
`

    it('reads modules from go.sum when asked for that kind', async function () {
        const result = await parse('go.sum', GO_SUM)
        expect(names(result).sort()).toEqual(['github.com/pkg/errors', 'golang.org/x/text'])
    })

    // The `/go.mod` suffix marks the second hash line for the same module, not a different version.
    it('strips the /go.mod suffix so the module is not double counted', async function () {
        const result = await parse('go.sum', GO_SUM)
        expect(names(result).filter(function isErrors(n) { return n === 'github.com/pkg/errors' })).toHaveLength(1)
    })

    it('ignores a line with no version', async function () {
        const result = await parse('go.sum', 'github.com/a/b\n')
        expect(result.status).toBe('unauditable')
    })

    // Stripping `/go.mod` from a version field that is nothing else leaves an empty version. The
    // module has to be dropped rather than recorded at version "", which would key a cache lookup
    // that can never match and report the module as clean.
    it('drops a module whose version is only the /go.mod marker', async function () {
        const text = 'github.com/a/b /go.mod h1:abc=\ngolang.org/x/text v0.14.0 h1:ghi=\n'
        const result = await parse('go.sum', text)
        expect(names(result).sort()).toEqual(['golang.org/x/text'])
    })

    it('is still classified partial', async function () {
        const result = await parse('go.sum', GO_SUM)
        expect(result.status).toBe('partial')
        expect(result.status === 'partial' && result.details.join(' ')).toContain('no go.mod')
    })

    // SENTINEL-131: a checksum database, not a build list. Which of several checksummed versions MVS
    // selected depends on the requirement graph go.sum does not hold, so the highest is no evidence: every
    // version stays a candidate, and an affected lower one is not discarded beside a fixed higher one.
    it('keeps every checksummed version of a module as a candidate', async function () {
        const text = 'github.com/a/b v1.0.0 h1:a=\ngithub.com/a/b v1.1.0 h1:b=\ngithub.com/a/b v1.1.0 h1:b=\n'
        const result = await parse('go.sum', text)
        expect(versions(result)).toEqual(['github.com/a/b@v1.0.0', 'github.com/a/b@v1.1.0'])
        expect(result.status === 'partial' && result.details.join(' ')).toContain('not proof of what the build selects')
    })

    // A `/go.mod` line only says the module's go.mod was read during resolution; nothing was built from it.
    it('ignores a module seen only through its go.mod hash', async function () {
        const text = 'github.com/a/b v1.0.0/go.mod h1:a=\ngithub.com/c/d v2.0.0 h1:b=\n'
        expect(names(await parse('go.sum', text))).toEqual(['github.com/c/d'])
    })

    it('ignores a version the Go comparator cannot read', async function () {
        expect((await parse('go.sum', 'github.com/a/b 1.2 h1:a=\n')).status).toBe('unauditable')
    })
})

function versions(result: Awaited<ReturnType<typeof parseGoMod>>): string[] {
    if (result.status === 'unauditable') return []
    return result.graph.packages.map(function nameAtVersion(p) { return p.name + '@' + p.version }).sort()
}

describe('parseGoMod replace directives', function () {
    // The toolchain builds the replacement, so that is what is matched: a fork under its own path.
    it('matches a module-version replacement under its own path and version', async function () {
        const result = await parse('go.mod', 'go 1.21\nrequire github.com/a/b v1.0.0\nreplace github.com/a/b => github.com/fork/b v1.0.1-fixed.1\n')
        expect(result.status).toBe('ok')
        expect(versions(result)).toEqual(['github.com/fork/b@v1.0.1-fixed.1'])
    })

    it('swaps only the version when the replacement keeps the path', async function () {
        const result = await parse('go.mod', 'go 1.21\nrequire github.com/a/b v1.0.0\nreplace (\n\tgithub.com/a/b => github.com/a/b v1.0.3\n)\n')
        expect(versions(result)).toEqual(['github.com/a/b@v1.0.3'])
    })

    // `old v => new v` replaces only that version of the module.
    it('applies a versioned replacement only to the version it names', async function () {
        const text = 'go 1.21\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v2.0.0\n)\nreplace github.com/a/b v0.9.0 => github.com/a/b v0.9.1\nreplace github.com/c/d v2.0.0 => github.com/c/d v2.0.1\n'
        expect(versions(await parse('go.mod', text))).toEqual(['github.com/a/b@v1.0.0', 'github.com/c/d@v2.0.1'])
    })

    // A local directory has no version to compare an advisory against: counted, never matched.
    it('counts a module replaced by a local directory as cannot be audited', async function () {
        const text = 'go 1.21\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v1.0.0\n)\nreplace github.com/a/b => ../b\n'
        const result = await parse('go.mod', text)
        expect(result.status).toBe('partial')
        expect(names(result)).toEqual(['github.com/c/d'])
        expect(result.status === 'partial' && result.details.join(' ')).toContain('github.com/a/b => ../b')
    })

    it('is unauditable when every module is replaced locally', async function () {
        const result = await parse('go.mod', 'go 1.21\nrequire github.com/a/b v1.0.0\nreplace github.com/a/b => ./b\n')
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.details.join(' ')).toContain('local directory')
    })

    it('ignores a malformed replace', async function () {
        const text = 'go 1.21\nrequire github.com/a/b v1.0.0\nreplace github.com/a/b\nreplace => x v1\nreplace github.com/a/b =>\n'
        expect(versions(await parse('go.mod', text))).toEqual(['github.com/a/b@v1.0.0'])
    })

    // A major-version suffix is part of the module path, and therefore of the name advisories key on.
    it('keeps a major-version module path distinct', async function () {
        const result = await parse('go.mod', 'go 1.21\nrequire (\n\tgithub.com/a/b v1.5.0\n\tgithub.com/a/b/v2 v2.1.0\n)\n')
        expect(names(result).sort()).toEqual(['github.com/a/b', 'github.com/a/b/v2'])
    })

    it('unquotes a quoted module path', async function () {
        expect(names(await parse('go.mod', 'go 1.21\nrequire "github.com/a/b" v1.0.0\n'))).toEqual(['github.com/a/b'])
    })
})

describe('parseGoMod directives without arguments', function () {
    it('reads a bare go directive as no version', async function () {
        const result = await parse('go.mod', 'go\nrequire github.com/a/b v1.0.0\n')
        expect(result.status === 'partial' && result.details.join(' ')).toContain('declares no go version')
    })
})
