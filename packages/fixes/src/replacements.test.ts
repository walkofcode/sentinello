import { describe, expect, it } from 'vitest'
import type { ManifestModule } from 'module-replacements'
import { createReplacementDataset } from './replacements'

// The dataset is the only source of alternatives (D2). What matters is that every kind of entry survives
// the translation, that a name with no entry is null (never a guess), and that a key only present on
// Object.prototype is not mistaken for an entry.

describe('the bundled e18e dataset', function () {
    const lookup = createReplacementDataset()

    it('maps fast-glob to tinyglobby, with its documentation link', function () {
        expect(lookup('fast-glob')).toEqual({ replaces: 'fast-glob', url: 'https://e18e.dev/docs/replacements/fast-glob', replacements: [{ kind: 'module', name: 'tinyglobby' }] })
    })

    it('has nothing for braces, nodemon or node-forge, and nothing for an inherited key', function () {
        expect(lookup('braces')).toBeNull()
        expect(lookup('nodemon')).toBeNull()
        expect(lookup('node-forge')).toBeNull()
        expect(lookup('constructor')).toBeNull()
    })
})

describe('every replacement kind', function () {
    const manifest: ManifestModule = {
        mappings: {
            old: { type: 'module', moduleName: 'old', replacements: ['mod', 'native', 'snippet', 'gone', 'toString', 'missing'] }
        },
        replacements: {
            mod: { id: 'mod', type: 'documented', replacementModule: 'new-mod' },
            native: { id: 'native', type: 'native', url: { type: 'mdn', id: 'Web/API/URL' } },
            snippet: { id: 'snippet', type: 'simple', description: 'use filter', url: 'https://example.test/snippet' },
            gone: { id: 'gone', type: 'removal', description: 'the platform covers it' }
        }
    }

    it('translates each, and skips an id the dataset does not define', function () {
        expect(createReplacementDataset(manifest)('old')).toEqual({
            replaces: 'old',
            url: null,
            replacements: [
                { kind: 'module', name: 'new-mod' },
                { kind: 'native', id: 'native', description: null, url: 'https://developer.mozilla.org/en-US/docs/Web/API/URL' },
                { kind: 'snippet', id: 'snippet', description: 'use filter', url: 'https://example.test/snippet' },
                { kind: 'removal', description: 'the platform covers it', url: null }
            ]
        })
    })

    it('keeps a native description when the dataset has one', function () {
        const described: ManifestModule = { mappings: { x: { type: 'module', moduleName: 'x', replacements: ['n'] } }, replacements: { n: { id: 'n', type: 'native', url: 'https://n', description: 'built in' } } }
        expect(createReplacementDataset(described)('x')?.replacements).toEqual([{ kind: 'native', id: 'n', description: 'built in', url: 'https://n' }])
    })
})
