import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { PORTAL_COOKIE_NAME, isPortalAuthEnabled, isValidSessionCookie } from '@/lib/portal-auth'

// Paths reachable without a session: the login page itself, the unauthenticated container health
// probe, and the MCP endpoint (which carries its own bearer token). Everything else requires the
// portal session cookie once SENTINELLO_PORTAL_TOKEN is set.
const EXEMPT_PREFIXES = ['/login', '/api/health', '/api/mcp']

export async function proxy(req: NextRequest): Promise<NextResponse> {
    const pathname = req.nextUrl.pathname
    // Surface the pathname to the root layout so it can drop the app chrome on /login (the chrome
    // would otherwise leak the running version to an unauthenticated visitor).
    const requestHeaders = new Headers(req.headers)
    requestHeaders.set('x-sentinello-pathname', pathname)
    const pass = NextResponse.next({ request: { headers: requestHeaders } })

    if (!isPortalAuthEnabled()) return pass
    if (isExempt(pathname)) return pass

    const cookie = req.cookies.get(PORTAL_COOKIE_NAME)?.value
    if (await isValidSessionCookie(cookie)) return pass

    if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'authentication required' }, { status: 401 })
    }
    const loginUrl = req.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.search = ''
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
}

function isExempt(pathname: string): boolean {
    for (const prefix of EXEMPT_PREFIXES) {
        if (pathname === prefix || pathname.startsWith(prefix + '/')) return true
    }
    return false
}

export const config = {
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
}
