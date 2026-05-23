import { getRequestConfig } from 'next-intl/server'
import { hasLocale } from 'next-intl'
import { routing } from './routing'

// Locale comes from the URL prefix ([locale] segment). Fall back to the default when the requested
// segment isn't a supported locale.
export default getRequestConfig(async function resolve({ requestLocale }) {
    const requested = await requestLocale
    const locale = (hasLocale(routing.locales, requested) && requested) || routing.defaultLocale
    const messages = (await import(`../messages/${locale}.json`)).default
    return { locale, messages }
})
