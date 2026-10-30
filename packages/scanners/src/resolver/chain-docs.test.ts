import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ECOSYSTEMS } from '@sentinello/core'
import { parseGoMod } from './go'
import { parsePythonLock } from './python'
import type { ResolverResult } from './types'

// docs/cli.md tells a reader which lockfiles leave a finding's chain unknown. It once said "the other
// lockfiles record one" after naming only requirements.txt and go.mod, which promised a graph for
// Pipfile.lock and go.sum. The page now names both sets; this holds them to the resolvers: every lockfile a
// resolver reads is in exactly one set, and each graphless one really gives no package a chain. The
// graph-bearing ones are proven by their own resolver suites (npm-lock, pnpm, python, rust, ruby).

const DOC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'docs', 'cli.md')

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-chain-docs-'))
})

afterEach(async function cleanup() {
    await rm(dir, { recursive: true, force: true })
})

// The backticked file names of the sentence containing `marker`.
async function namedIn(marker: string): Promise<string[]> {
    const text = (await readFile(DOC, 'utf8')).replace(/\s+/g, ' ')
    const sentence = text.split(/(?<=\.) /).find(function has(s) { return s.includes(marker) })
    if (sentence === undefined) throw new Error('docs/cli.md has no sentence containing "' + marker + '"')
    return [...sentence.matchAll(/`([^`]+)`/g)].map(function name(m) { return m[1] as string })
}

const SAMPLES: Record<string, { text: string; resolve: (path: string, kind: string) => Promise<ResolverResult> }> = {
    'requirements.txt': { text: 'django==4.2.0\n', resolve: python },
    'Pipfile.lock': { text: JSON.stringify({ default: { django: { version: '==4.2.0' } }, develop: {} }), resolve: python },
    'go.mod': { text: 'module example.com/app\n\ngo 1.22\n\nrequire example.com/lib v1.0.0\n', resolve: go },
    'go.sum': { text: 'example.com/lib v1.0.0 h1:x=\nexample.com/lib v1.0.0/go.mod h1:y=\n', resolve: go }
}

async function python(path: string, kind: string): Promise<ResolverResult> {
    return await parsePythonLock(dir, kind, path, kind)
}

async function go(path: string, kind: string): Promise<ResolverResult> {
    return await parseGoMod(kind, path, kind)
}

describe('docs/cli.md on dependency chains', function () {
    it('places every lockfile a resolver reads in exactly one of its two sets', async function () {
        const graphless = await namedIn('record no dependency graph')
        const withGraph = await namedIn('show the real chain')
        const read = ECOSYSTEMS.flatMap(function kinds(e) { return e.resolverKinds })
        expect([...graphless, ...withGraph].sort()).toEqual([...new Set(read)].sort())
    })

    it('names as graphless exactly the lockfiles whose resolver gives no package a chain', async function () {
        const graphless = await namedIn('record no dependency graph')
        expect(graphless.sort()).toEqual(Object.keys(SAMPLES).sort())
        for (const kind of graphless) {
            const sample = SAMPLES[kind] as (typeof SAMPLES)[string]
            const path = join(dir, kind)
            await writeFile(path, sample.text, 'utf8')
            const result = await sample.resolve(path, kind)
            if (result.status === 'unauditable') throw new Error(kind + ' did not resolve')
            expect(result.graph.packages.length).toBeGreaterThan(0)
            expect(result.graph.packages.every(function noChain(p) { return p.depPaths.length === 0 })).toBe(true)
        }
    })
})
