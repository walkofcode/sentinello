'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { PORTAL_COOKIE_NAME, getPortalToken, isPortalAuthEnabled, sessionCookieValue, tokenMatches } from '@/lib/portal-auth'

const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30

export type LoginState = { error?: string }

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
    const token = getPortalToken()
    if (!token) redirect('/')
    const submitted = String(formData.get('token') || '')
    if (!(await tokenMatches(submitted))) {
        return { error: 'invalid' }
    }
    const store = await cookies()
    store.set(PORTAL_COOKIE_NAME, await sessionCookieValue(token), {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_SEC
    })
    redirect(safeNext(String(formData.get('next') || '/')))
}

export async function logoutAction(): Promise<void> {
    if (isPortalAuthEnabled()) {
        const store = await cookies()
        store.delete(PORTAL_COOKIE_NAME)
    }
    redirect('/login')
}

// Only allow same-origin relative paths as the post-login destination, so a crafted ?next= can't
// bounce the operator to an external site or a protocol-relative URL.
function safeNext(next: string): string {
    if (!next.startsWith('/') || next.startsWith('//')) return '/'
    return next
}
