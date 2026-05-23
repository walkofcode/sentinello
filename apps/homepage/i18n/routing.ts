import { defineRouting } from 'next-intl/routing'
import { locales, defaultLocale } from './config'

// URL-prefixed locales (/en, /es, /ja, …). 'as-needed' would drop the prefix for the default
// locale, but a marketing site wants every language at its own indexable URL, so always prefix.
export const routing = defineRouting({
    locales,
    defaultLocale,
    localePrefix: 'always'
})
