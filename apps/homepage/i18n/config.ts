// The supported-language set lives in @sentinello/core (LOCALES) so the homepage, the portal, and
// core's localized label maps can never drift. Adding a language means adding it in core plus a
// matching messages/<locale>.json catalog and a LOCALE_LABELS entry below.
import { LOCALES, type Locale } from '@sentinello/core'

export const locales = LOCALES

export type { Locale }

export const defaultLocale: Locale = 'en'

// Name of each language in its own language, shown in the switcher menu. Mirrors the portal's map.
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

export function isLocale(value: unknown): value is Locale {
    return typeof value === 'string' && LOCALES.includes(value as Locale)
}
