// The supported-language set lives in @sentinello/core (LOCALES) so the portal's i18n and core's
// localized label maps (reason codes, scan status) can never drift. The switcher, the request-config
// validation, and the locale cookie all key off this list; adding a language means adding it in core
// plus a matching messages/<locale>.json catalog and a LOCALE_LABELS entry below.
import { LOCALES, type Locale } from '@sentinello/core'

export const locales = LOCALES

export type { Locale }

export const defaultLocale: Locale = 'en'

// Name of each language in its own language, shown in the switcher menu.
export const LOCALE_LABELS: Record<Locale, string> = {
    'en': 'English',
    'es': 'Español',
    'fr': 'Français',
    'de': 'Deutsch',
    'pt-BR': 'Português (Brasil)',
    'it': 'Italiano',
    'ja': '日本語',
    'zh-CN': '简体中文',
    'ko': '한국어',
    'ru': 'Русский'
}

// Cookie next-intl reads on every request to pick the active locale. Shared by request.ts (read)
// and set-locale.ts (write) so the name never drifts.
export const LOCALE_COOKIE = 'NEXT_LOCALE'

export function isLocale(value: unknown): value is Locale {
    return typeof value === 'string' && LOCALES.includes(value as Locale)
}
