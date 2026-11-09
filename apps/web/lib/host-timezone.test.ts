import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostTimezone } from './host-timezone'

function formatterReporting(timeZone: string): Intl.DateTimeFormat {
    return { resolvedOptions: function resolvedOptions() { return { timeZone } } } as Intl.DateTimeFormat
}

afterEach(function restore() {
    vi.restoreAllMocks()
})

describe('hostTimezone', function () {
    it('is the zone the runtime resolves', function () {
        vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue(formatterReporting('Asia/Kathmandu'))
        expect(hostTimezone()).toBe('Asia/Kathmandu')
    })

    // A runtime with no timezone data reports nothing: a time of day still has to mean something.
    it('is UTC when the runtime resolves an empty zone', function () {
        vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue(formatterReporting(''))
        expect(hostTimezone()).toBe('UTC')
    })

    it('is UTC when the runtime cannot resolve one at all', function () {
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function noData(): never {
            throw new RangeError('no timezone data')
        })
        expect(hostTimezone()).toBe('UTC')
    })
})
