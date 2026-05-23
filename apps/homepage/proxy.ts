import createMiddleware from 'next-intl/middleware'
import { routing } from './i18n/routing'

// Next 16's proxy convention (the renamed middleware). Redirects '/' to the best-matching locale
// (Accept-Language → default) and keeps the prefix on every navigation. Matcher skips API, Next
// internals, and any path with a file extension.
export default createMiddleware(routing)

export const config = {
    matcher: '/((?!api|_next|_vercel|.*\\..*).*)'
}
