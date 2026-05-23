export const HOME_URL_KEY = 'sentinello:home-url'

export function rememberHomeUrl(url: string): void {
    if (typeof window === 'undefined') return
    try {
        window.sessionStorage.setItem(HOME_URL_KEY, url)
    } catch {
        // sessionStorage can throw in privacy mode / quota; swallow silently
    }
}

export function recallHomeUrl(): string | null {
    if (typeof window === 'undefined') return null
    try {
        return window.sessionStorage.getItem(HOME_URL_KEY)
    } catch {
        return null
    }
}
