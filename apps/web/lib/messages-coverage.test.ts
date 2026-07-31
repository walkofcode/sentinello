import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { locales } from '@/i18n/config'

// Drift guard for apps/web/messages/*.json, in the spirit of the tables already covered by
// packages/core/src/i18n-coverage.test.ts — which guards the reason-code and scan-status labels but
// has never reached these files.
//
// The gap is not theoretical: adding a key to en.json and forgetting the other nine renders the raw
// key path to the user in that locale, and nothing fails until someone browsing in German sees
// "Settings.mcp.clearConfirmTitle" in a dialog. Ten hand-edited files is exactly the count at which
// one gets missed.

// Under lib/ rather than beside the catalogues because vitest.config.ts collects only
// apps/web/{lib,components}/**; a test file sitting next to the JSON would never have run.
const HERE = dirname(fileURLToPath(import.meta.url))
const MESSAGES = resolve(HERE, '..', 'messages')

type Tree = { [key: string]: string | Tree }

function load(locale: string): Tree {
    return JSON.parse(readFileSync(resolve(MESSAGES, locale + '.json'), 'utf8')) as Tree
}

// Dotted leaf path -> string value. Paths are compared as sets, so both a missing key and a stray one
// are named precisely rather than reported as "the objects differ"; the values ride along so the
// empty-string check does not have to walk the tree a second time.
function leaves(tree: Tree, prefix = ''): Map<string, string> {
    const out = new Map<string, string>()
    for (const [key, value] of Object.entries(tree)) {
        const path = prefix ? prefix + '.' + key : key
        if (typeof value === 'string') out.set(path, value)
        else for (const [k, v] of leaves(value, path)) out.set(k, v)
    }
    return out
}

function leafPaths(tree: Tree): string[] {
    return [...leaves(tree).keys()].sort()
}

describe('portal message catalogues', function () {
    const english = leafPaths(load('en'))

    it('defines at least one key, so a broken loader cannot pass this file vacuously', function () {
        expect(english.length).toBeGreaterThan(100)
    })

    // Split into missing/stray rather than a single toEqual: the failure output is the whole point of
    // this test, and "de is missing Settings.mcp.clearConfirmBody" is actionable where a 900-line
    // array diff is not.
    for (const locale of locales) {
        if (locale === 'en') continue

        it('covers every English key in ' + locale, function () {
            const theirs = new Set(leafPaths(load(locale)))
            expect(english.filter(function absent(k) { return !theirs.has(k) })).toEqual([])
        })

        it('defines no key English does not have in ' + locale, function () {
            const ours = new Set(english)
            expect(leafPaths(load(locale)).filter(function stray(k) { return !ours.has(k) })).toEqual([])
        })
    }

    // A key whose value is an empty string renders as nothing at all, which reads as a layout bug
    // rather than a translation gap. Catching it here names the locale and key instead.
    it('has no empty values in any locale', function () {
        const empty: string[] = []
        for (const locale of locales) {
            for (const [path, value] of leaves(load(locale))) {
                if (value.trim().length === 0) empty.push(locale + '/' + path)
            }
        }
        expect(empty).toEqual([])
    })
})
