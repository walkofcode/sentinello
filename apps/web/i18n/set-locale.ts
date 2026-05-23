'use server'

import { cookies } from 'next/headers'
import { isLocale, LOCALE_COOKIE } from './config'

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

// Server action invoked by the language switcher. Persists the chosen locale in the cookie that
// request.ts reads; the client follows up with router.refresh() so every server component re-renders
// in the new language. Ignores unsupported values rather than throwing — the UI only ever sends
// known locales, and a bad value should not crash the action.
export async function setLocale(locale: string): Promise<void> {
    if (!isLocale(locale)) return
    const store = await cookies()
    store.set(LOCALE_COOKIE, locale, { path: '/', maxAge: ONE_YEAR_SECONDS, sameSite: 'lax' })
}
