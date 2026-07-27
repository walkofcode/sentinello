import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseGoMod } from './go'

// Go is resolved offline from go.mod (falling back to go.sum), which cannot prove the fully-pruned
// build graph. The classification therefore has to stay `partial` — reporting `ok` would imply a
// completeness we did not earn, so that status is asserted explicitly rather than incidentally.

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
        const result = await parseGoMod('go.mod', join(dir, 'nope.mod'))
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('ambiguous_dependency_spec')
    })

    it('is unauditable when no modules are found', async function () {
        const result = await parseGoMod('go.mod', await write('go.mod', 'module example.com/app\n\ngo 1.22\n'))
        expect(result.status).toBe('unauditable')
    })

    it('names the file it could not use in the details', async function () {
        const result = await parseGoMod('go.mod', join(dir, 'nope.mod'))
        expect(result.status === 'unauditable' && result.details.join(' ')).toContain('go.mod')
    })
})

describe('parseGoMod reading go.mod', function () {
    it('reads modules from a require block and a single require', async function () {
        const result = await parseGoMod('go.mod', await write('go.mod', GO_MOD))
        expect(names(result).sort()).toEqual([
            'github.com/pkg/errors',
            'github.com/spf13/cobra',
            'golang.org/x/text'
        ])
    })

    // Offline parsing cannot prove the pruned graph, so the result discloses that rather than
    // claiming a complete resolution.
    it('classifies the result as partial with a disclosure', async function () {
        const result = await parseGoMod('go.mod', await write('go.mod', GO_MOD))
        expect(result.status).toBe('partial')
        expect(result.status === 'partial' && result.reasonCode).toBe('partial_dependency_graph')
        expect(result.status === 'partial' && result.details.join(' ')).toContain('go list -m all')
    })

    it('reports the Go ecosystem', async function () {
        const result = await parseGoMod('go.mod', await write('go.mod', GO_MOD))
        expect(result.ecosystem).toBe('Go')
    })

    // Indirect modules are still installed code and can still be vulnerable, so the `// indirect`
    // marker must not exclude them.
    it('includes indirect modules', async function () {
        const result = await parseGoMod('go.mod', await write('go.mod', GO_MOD))
        expect(names(result)).toContain('golang.org/x/text')
    })

    it('keeps the v-prefixed version for the semver comparator', async function () {
        const result = await parseGoMod('go.mod', await write('go.mod', GO_MOD))
        const pkg = result.status !== 'unauditable' && result.graph.byName('github.com/pkg/errors')[0]
        expect(pkg && pkg.version).toBe('v0.9.1')
    })

    // Go has no module-level dev/test scope, so everything is prod.
    it('treats every module as a production dependency', async function () {
        const result = await parseGoMod('go.mod', await write('go.mod', GO_MOD))
        if (result.status === 'unauditable') throw new Error('expected a graph')
        for (const pkg of result.graph.packages) {
            expect(pkg.scope).toEqual({ isProd: true, isDev: false, isOptional: false })
        }
    })

    it('ignores a comment-only line', async function () {
        const text = 'require (\n\t// a note\n\tgithub.com/a/b v1.0.0\n)\n'
        expect(names(await parseGoMod('go.mod', await write('go.mod', text)))).toEqual(['github.com/a/b'])
    })

    it('handles CRLF line endings', async function () {
        const text = 'require (\r\n\tgithub.com/a/b v1.0.0\r\n)\r\n'
        expect(names(await parseGoMod('go.mod', await write('go.mod', text)))).toEqual(['github.com/a/b'])
    })

    it('deduplicates a module repeated at the same version', async function () {
        const text = 'require (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/a/b v1.0.0\n)\n'
        expect(names(await parseGoMod('go.mod', await write('go.mod', text)))).toEqual(['github.com/a/b'])
    })

    it('keeps a module listed at two versions', async function () {
        const text = 'require (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/a/b v2.0.0\n)\n'
        expect(names(await parseGoMod('go.mod', await write('go.mod', text)))).toHaveLength(2)
    })

    it('ignores a require entry with no version', async function () {
        const text = 'require (\n\tgithub.com/a/b\n\tgithub.com/c/d v1.0.0\n)\n'
        expect(names(await parseGoMod('go.mod', await write('go.mod', text)))).toEqual(['github.com/c/d'])
    })
})

describe('parseGoMod reading go.sum', function () {
    const GO_SUM = `github.com/pkg/errors v0.9.1 h1:abc=
github.com/pkg/errors v0.9.1/go.mod h1:def=
golang.org/x/text v0.14.0 h1:ghi=
`

    it('reads modules from go.sum when asked for that kind', async function () {
        const result = await parseGoMod('go.sum', await write('go.sum', GO_SUM))
        expect(names(result).sort()).toEqual(['github.com/pkg/errors', 'golang.org/x/text'])
    })

    // The `/go.mod` suffix marks the second hash line for the same module, not a different version.
    it('strips the /go.mod suffix so the module is not double counted', async function () {
        const result = await parseGoMod('go.sum', await write('go.sum', GO_SUM))
        expect(names(result).filter(function isErrors(n) { return n === 'github.com/pkg/errors' })).toHaveLength(1)
    })

    it('ignores a line with no version', async function () {
        const result = await parseGoMod('go.sum', await write('go.sum', 'github.com/a/b\n'))
        expect(result.status).toBe('unauditable')
    })

    it('is still classified partial', async function () {
        const result = await parseGoMod('go.sum', await write('go.sum', GO_SUM))
        expect(result.status).toBe('partial')
    })
})
