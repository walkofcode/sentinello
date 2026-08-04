import { describe, expect, it } from 'vitest'
import { LOCALES, REASON_CODE_VALUES, SCAN_STATUS_VALUES } from './types'
import { REASON_CODE_LABELS, reasonCodeLabel } from './reason-code-labels'
import { SCAN_STATUS_LABELS, scanStatusLabel } from './scan-status-labels'
import { RELEASES, RELEASE_COPY, getLatestRelease, getReleaseCopy, getReleaseFor, getReleases } from './releases'

// Drift guards. These tables are edited by hand across ten locales, so the realistic failure is a
// key added to the vocabulary in types.ts and translated in English only. Each test below fails
// loudly on exactly that, naming the locale and key rather than surfacing later as a portal render
// error or a silently English notification.
describe('reason code labels', function () {
    it('covers every reason code in every locale', function () {
        const missing: string[] = []
        for (const locale of LOCALES) {
            for (const code of REASON_CODE_VALUES) {
                const table = REASON_CODE_LABELS[locale]
                if (!table || typeof table[code] !== 'string' || table[code].length === 0) {
                    missing.push(locale + '/' + code)
                }
            }
        }
        expect(missing).toEqual([])
    })

    it('covers the unknown key in every locale', function () {
        for (const locale of LOCALES) {
            expect(typeof REASON_CODE_LABELS[locale]?.unknown).toBe('string')
        }
    })

    it('defines no label for a code that is not in the vocabulary', function () {
        const known = new Set<string>([...REASON_CODE_VALUES, 'unknown'])
        const strays: string[] = []
        for (const locale of LOCALES) {
            for (const key of Object.keys(REASON_CODE_LABELS[locale] ?? {})) {
                if (!known.has(key)) strays.push(locale + '/' + key)
            }
        }
        expect(strays).toEqual([])
    })

    it('maps a null code onto the unknown label', function () {
        expect(reasonCodeLabel(null)).toBe(REASON_CODE_LABELS.en.unknown)
    })

    it('falls back to English for an unrecognised locale', function () {
        expect(reasonCodeLabel('ok', 'kl' as never)).toBe(REASON_CODE_LABELS.en.ok)
    })

    // The last resort: a code with no label in any locale is echoed back rather than rendering as
    // "undefined". Only reachable through a cast, but it is what keeps the portal readable when the
    // worker starts emitting a reason code before the label tables catch up.
    it('echoes back a code that no locale has a label for', function () {
        expect(reasonCodeLabel('not_a_real_code' as never)).toBe('not_a_real_code')
    })
})

describe('scan status labels', function () {
    it('resolves a non-empty label for every status in every locale', function () {
        const missing: string[] = []
        for (const locale of LOCALES) {
            for (const status of SCAN_STATUS_VALUES) {
                const label = scanStatusLabel(status, locale)
                if (typeof label !== 'string' || label.length === 0) missing.push(locale + '/' + status)
            }
        }
        expect(missing).toEqual([])
    })

    it('falls back to English for an unrecognised locale', function () {
        expect(scanStatusLabel('ok', 'kl' as never)).toBe(SCAN_STATUS_LABELS.en.ok)
    })

    it('echoes back a status that no locale has a label for', function () {
        expect(scanStatusLabel('not_a_real_status' as never)).toBe('not_a_real_status')
    })
})

describe('release notes', function () {
    it('lists releases newest first', function () {
        const dates = RELEASES.map(function toDate(r) {
            return Date.parse(r.date)
        })
        const sorted = [...dates].sort(function descending(a, b) {
            return b - a
        })
        expect(dates).toEqual(sorted)
    })

    it('gives every listed release an English entry', function () {
        const missing: string[] = []
        for (const release of RELEASES) {
            const copy = RELEASE_COPY.en?.[release.version]
            if (!copy || !copy.title || copy.items.length === 0) missing.push(release.version)
        }
        expect(missing).toEqual([])
    })

    // The inverse of the stray check below, and the one that was missing. pt-BR and zh-CN both shipped
    // without a 2.6.0 entry and nothing caught it: the English-completeness check passes because `en` is
    // complete, the stray check passes because a MISSING key is not a stray, and the fallback check
    // cannot fail by construction — getReleaseCopy substitutes English per version, so it is non-null
    // whether or not the translation exists. The only visible symptom was one English entry sitting
    // between two localized ones, which nobody is going to notice in a locale they do not read.
    it('gives every listed release an entry in every locale, not just a fallback', function () {
        const missing: string[] = []
        for (const locale of LOCALES) {
            for (const release of RELEASES) {
                const copy = RELEASE_COPY[locale]?.[release.version]
                if (!copy || !copy.title || copy.items.length === 0) missing.push(locale + '/' + release.version)
            }
        }
        expect(missing).toEqual([])
    })

    // Every version key in any locale must correspond to a real release, or the pill and the notes
    // list silently disagree about what shipped.
    it('has no copy for a version that is not in the release list', function () {
        const known = new Set(RELEASES.map(function version(r) {
            return r.version
        }))
        const strays: string[] = []
        for (const locale of LOCALES) {
            for (const version of Object.keys(RELEASE_COPY[locale] ?? {})) {
                if (!known.has(version)) strays.push(locale + '/' + version)
            }
        }
        expect(strays).toEqual([])
    })

    it('returns the newest release from getLatestRelease', function () {
        expect(getLatestRelease()).toEqual(RELEASES[0])
    })

    // The portal's release-notes list reads through getReleases rather than importing RELEASES, so
    // the accessor is the contract the UI actually depends on.
    it('returns the whole list from getReleases', function () {
        expect(getReleases()).toEqual(RELEASES)
        expect(getReleases().length).toBeGreaterThan(0)
    })

    it('looks a release up with or without a v prefix', function () {
        const first = RELEASES[0]
        if (!first) throw new Error('expected at least one release')
        expect(getReleaseFor(first.version)).toEqual(first)
        expect(getReleaseFor('v' + first.version)).toEqual(first)
    })

    // A version mismatch must be fail-safe: the pill simply does not render.
    it('returns null for an unknown version rather than throwing', function () {
        expect(getReleaseFor('0.0.0-nope')).toBeNull()
        expect(getReleaseCopy('en', '0.0.0-nope')).toBeNull()
    })

    // A locale that has not been translated yet degrades to English rather than erroring.
    it('falls back to English copy when a locale has no entry', function () {
        const first = RELEASES[0]
        if (!first) throw new Error('expected at least one release')
        for (const locale of LOCALES) {
            expect(getReleaseCopy(locale, first.version)).not.toBeNull()
        }
    })

    // The other half of that fallback: a locale with no table at all, rather than a locale whose
    // table is missing one version. Asserting against the English entry — and proving it exists
    // first — keeps this from passing vacuously on two undefineds.
    it('falls back to English copy for a locale with no table at all', function () {
        const first = RELEASES[0]
        if (!first) throw new Error('expected at least one release')
        const english = RELEASE_COPY.en[first.version]
        expect(english).toBeDefined()
        expect(getReleaseCopy('kl' as never, first.version)).toEqual(english)
    })
})
