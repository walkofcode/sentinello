import { describe, expect, it } from 'vitest'
import { DEFAULT_WEEKLY_DIGEST, digestWeekKey, latestDigestDue } from './digest-schedule'

const MONDAY_9 = { day: 1, hour: 9 }

describe('latestDigestDue', function () {
    it('defaults to Monday 09:00', function () {
        expect(DEFAULT_WEEKLY_DIGEST).toEqual(MONDAY_9)
    })

    it('returns the latest due instant at or before now, in its timezone', function () {
        const due = Date.UTC(2026, 10, 2, 9)
        expect(latestDigestDue(MONDAY_9, 'UTC', due)).toEqual({ dueAt: due, weekKey: '2026-W45' })
        expect(latestDigestDue(MONDAY_9, 'UTC', due + 3 * 86_400_000).dueAt).toBe(due)
        expect(latestDigestDue(MONDAY_9, 'UTC', due - 1)).toEqual({ dueAt: due - 7 * 86_400_000, weekKey: '2026-W44' })
    })

    it('fires at the local hour in fractional-offset zones', function () {
        expect(latestDigestDue(MONDAY_9, 'Asia/Kathmandu', Date.UTC(2026, 10, 2, 3, 15)).dueAt).toBe(Date.UTC(2026, 10, 2, 3, 15))
        expect(latestDigestDue(MONDAY_9, 'Asia/Kolkata', Date.UTC(2026, 10, 2, 3, 30)).dueAt).toBe(Date.UTC(2026, 10, 2, 3, 30))
        expect(latestDigestDue(MONDAY_9, 'Asia/Kolkata', Date.UTC(2026, 10, 2, 3, 29)).weekKey).toBe('2026-W44')
    })

    it('falls a skipped local hour to the next one that exists', function () {
        // America/New_York, Sunday 2026-03-08: 02:00 jumps to 03:00 EDT, which is 07:00 UTC.
        const sundayTwo = { day: 0, hour: 2 }
        expect(latestDigestDue(sundayTwo, 'America/New_York', Date.UTC(2026, 2, 8, 12)).dueAt).toBe(Date.UTC(2026, 2, 8, 7))
    })

    it('holds a repeated local hour to its first instant', function () {
        // America/New_York, Sunday 2026-11-01: 01:30 happens at 05:30 and 06:30 UTC. 01:00 EDT is 05:00 UTC.
        const sundayOne = { day: 0, hour: 1 }
        const first = Date.UTC(2026, 10, 1, 5)
        expect(latestDigestDue(sundayOne, 'America/New_York', first)).toEqual({ dueAt: first, weekKey: '2026-W44' })
        expect(latestDigestDue(sundayOne, 'America/New_York', first + 3_600_000)).toEqual({ dueAt: first, weekKey: '2026-W44' })
    })

    it('reads the system timezone when the schedule names none', function () {
        const now = Date.UTC(2026, 10, 4, 12)
        const { dueAt, weekKey } = latestDigestDue(MONDAY_9, undefined, now)
        expect(dueAt).toBeLessThanOrEqual(now)
        expect(weekKey).toBe(digestWeekKey(dueAt, undefined))
    })

    it('throws on a timezone the runtime does not know', function () {
        expect(function bad() { latestDigestDue(MONDAY_9, 'Mars/Olympus', Date.now()) }).toThrow()
    })
})

describe('digestWeekKey', function () {
    it('is the ISO week of the local date, across a year boundary', function () {
        expect(digestWeekKey(Date.UTC(2026, 0, 1, 12), 'UTC')).toBe('2026-W01')
        expect(digestWeekKey(Date.UTC(2027, 0, 3, 12), 'UTC')).toBe('2026-W53')
        expect(digestWeekKey(Date.UTC(2027, 0, 4, 12), 'UTC')).toBe('2027-W01')
        expect(digestWeekKey(Date.UTC(2024, 11, 30, 12), 'UTC')).toBe('2025-W01')
    })

    it('reads the same instant as another week in another zone', function () {
        const sundayNight = Date.UTC(2026, 10, 1, 19)
        expect(digestWeekKey(sundayNight, 'UTC')).toBe('2026-W44')
        expect(digestWeekKey(sundayNight, 'Pacific/Kiritimati')).toBe('2026-W45')
    })

    it('holds neither the day nor the hour, so a schedule edit reads the same week', function () {
        expect(latestDigestDue(MONDAY_9, 'UTC', Date.UTC(2026, 10, 3, 12)).weekKey).toBe(latestDigestDue({ day: 2, hour: 9 }, 'UTC', Date.UTC(2026, 10, 3, 12)).weekKey)
    })
})
