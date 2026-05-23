import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { defaultLocale, isLocale, LOCALE_COOKIE } from './config'

// Cookie-driven locale resolution (no URL-prefix routing). Runs on every request — the site is
// force-dynamic so reading the cookie here costs nothing extra. Falls back to the default locale
// when the cookie is missing or holds an unsupported value.
export default getRequestConfig(async function resolve() {
    const store = await cookies()
    const cookieValue = store.get(LOCALE_COOKIE)?.value
    const locale = (isLocale(cookieValue) && cookieValue) || defaultLocale
    const messages = (await import(`../messages/${locale}.json`)).default
    return { locale, messages }
})
