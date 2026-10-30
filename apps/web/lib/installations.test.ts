import { describe, expect, it } from 'vitest'
import { installationsText, installationsWorthShowing } from './installations'

describe('installationsWorthShowing', function () {
    it('names several manifests, or one below the project root, and not a lone root lockfile', function () {
        expect(installationsWorthShowing([])).toBe(false)
        expect(installationsWorthShowing([{ manifestPath: 'package-lock.json', version: '4.17.20' }])).toBe(false)
        expect(installationsWorthShowing([{ manifestPath: 'ios/Gemfile.lock', version: '2.0.8' }])).toBe(true)
        expect(installationsWorthShowing([{ manifestPath: 'Gemfile.lock', version: '2.0.8' }, { manifestPath: 'Gemfile.lock', version: '2.1.0' }])).toBe(true)
    })
})

describe('installationsText', function () {
    it('lists each manifest with its version', function () {
        expect(installationsText([{ manifestPath: 'ios/Gemfile.lock', version: '2.0.8' }, { manifestPath: 'android/Gemfile.lock', version: '2.1.0' }])).toBe('ios/Gemfile.lock 2.0.8, android/Gemfile.lock 2.1.0')
    })
})
