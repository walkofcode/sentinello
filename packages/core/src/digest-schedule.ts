// When a weekly digest is due. Pure: a { day, hour } in a timezone and a clock go in, an instant and a calendar
// week come out. The worker's tick (apps/worker/src/weekly-digest.ts) and its ledger are built on these two facts.

export type WeeklyDigestSchedule = {
    // 0 is Sunday, as Date.getUTCDay and the portal's picker read it.
    day: number
    // 0 to 23, local to the schedule's timezone.
    hour: number
}

export const DEFAULT_WEEKLY_DIGEST: WeeklyDigestSchedule = { day: 1, hour: 9 }

export type DigestDue = {
    // The latest due instant at or before now.
    dueAt: number
    // The ISO 8601 calendar week of that instant's local date (2026-W45). It holds neither the day nor the hour,
    // so moving Monday's digest to Tuesday reads the same week and cannot mint a second one.
    weekKey: string
}

const DAY_MS = 24 * 60 * 60 * 1000

type LocalTime = { year: number; month: number; day: number; hour: number; minute: number; second: number }

// One formatter per zone: building one is the costly part, and a tick reads the same zone for every target.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string | undefined): Intl.DateTimeFormat {
    const key = timezone ?? ''
    const known = FORMATTERS.get(key)
    if (known) return known
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric'
    })
    FORMATTERS.set(key, formatter)
    return formatter
}

function localTime(instant: number, timezone: string | undefined): LocalTime {
    const fields: Record<string, number> = {}
    for (const part of formatterFor(timezone).formatToParts(instant)) {
        if (part.type !== 'literal') fields[part.type] = Number(part.value)
    }
    return { year: fields.year as number, month: fields.month as number, day: fields.day as number, hour: fields.hour as number, minute: fields.minute as number, second: fields.second as number }
}

// The offset of the zone at an instant, in ms east of UTC.
function offsetAt(instant: number, timezone: string | undefined): number {
    const local = localTime(instant, timezone)
    const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
    return asUtc - Math.floor(instant / 1000) * 1000
}

// The earliest instant that reads as this local hour, or null when the hour does not exist that day. The offsets
// a day either side cover both sides of any transition, and a repeated hour yields both instants.
function instantsOfLocalHour(year: number, month: number, day: number, hour: number, timezone: string | undefined): number | null {
    const wall = Date.UTC(year, month - 1, day, hour)
    const candidates = [wall - offsetAt(wall - DAY_MS, timezone), wall - offsetAt(wall + DAY_MS, timezone)]
    const matching = candidates.filter(function reads(instant) {
        const local = localTime(instant, timezone)
        return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) === wall
    })
    return matching.length === 0 ? null : Math.min(...matching)
}

// A skipped local hour falls to the next hour that exists.
function dueInstantOfLocalDate(year: number, month: number, day: number, hour: number, timezone: string | undefined): number {
    for (let next = hour; ; next++) {
        const instant = instantsOfLocalHour(year, month, day, next, timezone)
        if (instant !== null) return instant
    }
}

// The ISO 8601 week of a calendar date: the week belongs to the year holding its Thursday.
function isoWeekKey(year: number, month: number, day: number): string {
    const date = new Date(Date.UTC(year, month - 1, day))
    const thursday = date.getTime() + (3 - ((date.getUTCDay() + 6) % 7)) * DAY_MS
    const isoYear = new Date(thursday).getUTCFullYear()
    const week = Math.floor((thursday - Date.UTC(isoYear, 0, 1)) / (7 * DAY_MS)) + 1
    return isoYear + '-W' + String(week).padStart(2, '0')
}

// The calendar week an instant falls in, in a timezone. Keys of one padding compare as strings, oldest first.
export function digestWeekKey(instant: number, timezone: string | undefined): string {
    const local = localTime(instant, timezone)
    return isoWeekKey(local.year, local.month, local.day)
}

// The latest due instant at or before now, and its week. A timezone the runtime does not know throws: the tick
// logs it and sends nothing, rather than sending at an hour nobody chose.
export function latestDigestDue(schedule: WeeklyDigestSchedule, timezone: string | undefined, now: number): DigestDue {
    const today = localTime(now, timezone)
    const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay()
    const daysBack = (weekday - schedule.day + 7) % 7
    function dueDaysAgo(back: number): number {
        const date = new Date(Date.UTC(today.year, today.month - 1, today.day - back))
        return dueInstantOfLocalDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), schedule.hour, timezone)
    }
    // Today's weekday may not have reached its hour yet; a week earlier always has.
    const thisOne = dueDaysAgo(daysBack)
    const dueAt = thisOne <= now ? thisOne : dueDaysAgo(daysBack + 7)
    return { dueAt, weekKey: digestWeekKey(dueAt, timezone) }
}
