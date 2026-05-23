// Small formatting helpers shared by server and client components. Keep these pure and deterministic
// so SSR + hydration agree. Locale-aware strings are produced by a translator the caller passes in —
// both next-intl's getTranslations() (server) and useTranslations() (client) scoped to the 'Time'
// namespace satisfy this signature, so a single helper works in either rendering context.

export type Translator = (key: string, values?: Record<string, string | number>) => string

export function formatRelativeTime(at: number | null, t: Translator, now = Date.now()): string {
    if (!at) return t('never')
    const delta = now - at
    if (delta < 0) return t('inFuture')
    const sec = Math.floor(delta / 1000)
    if (sec < 60) return t('justNow')
    const min = Math.floor(sec / 60)
    if (min < 60) return t('minutesAgo', { n: min })
    const hr = Math.floor(min / 60)
    if (hr < 24) return t('hoursAgo', { n: hr })
    const day = Math.floor(hr / 24)
    if (day < 30) return t('daysAgo', { n: day })
    const mo = Math.floor(day / 30)
    if (mo < 12) return t('monthsAgo', { n: mo })
    const yr = Math.floor(mo / 12)
    return t('yearsAgo', { n: yr })
}

export function formatAbsoluteTime(at: number | null): string {
    if (!at) return '—'
    return new Date(at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

export function formatDuration(ms: number | null): string {
    if (ms == null) return '—'
    if (ms < 1000) return ms + 'ms'
    const s = (ms / 1000).toFixed(1)
    return s + 's'
}

// Coarser duration formatter for lifecycle windows (advisory exposure). Avoids the millisecond /
// second granularity of formatDuration which is geared toward scan timing. The unit suffixes are
// localized via the passed translator (scoped to the 'Time' namespace).
export function formatExposureWindow(ms: number | null, t: Translator): string {
    if (ms == null) return '—'
    if (ms < 0) return '—'
    const min = Math.floor(ms / 60000)
    if (min < 1) return t('windowUnderMinute')
    if (min < 60) return t('windowMinutes', { n: min })
    const hr = Math.floor(min / 60)
    if (hr < 24) return t('windowHours', { n: hr })
    const day = Math.floor(hr / 24)
    if (day < 30) return t('windowDays', { n: day })
    const mo = Math.floor(day / 30)
    if (mo < 12) return t('windowMonths', { n: mo })
    const yr = Math.floor(mo / 12)
    return t('windowYears', { n: yr })
}

export function parseJsonArray(json: string): string[] {
    try {
        const parsed = JSON.parse(json) as unknown
        if (!Array.isArray(parsed)) return []
        return parsed.filter(function isString(v): v is string {
            return typeof v === 'string'
        })
    } catch {
        return []
    }
}

export function pluralize(n: number, singular: string, plural?: string): string {
    if (n === 1) return n + ' ' + singular
    return n + ' ' + (plural || singular + 's')
}
