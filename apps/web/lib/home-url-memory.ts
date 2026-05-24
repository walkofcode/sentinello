const PROJECTS_URL_KEY = 'sentinello:home-url:projects'
const LIBRARIES_URL_KEY = 'sentinello:home-url:libraries'

function write(key: string, url: string): void {
    if (typeof window === 'undefined') return
    try {
        window.sessionStorage.setItem(key, url)
    } catch {
        // sessionStorage can throw in privacy mode / quota; swallow silently
    }
}

function read(key: string): string | null {
    if (typeof window === 'undefined') return null
    try {
        return window.sessionStorage.getItem(key)
    } catch {
        return null
    }
}

export function rememberProjectsUrl(url: string): void {
    write(PROJECTS_URL_KEY, url)
}

export function recallProjectsUrl(): string | null {
    return read(PROJECTS_URL_KEY)
}

export function rememberLibrariesUrl(url: string): void {
    write(LIBRARIES_URL_KEY, url)
}

export function recallLibrariesUrl(): string | null {
    return read(LIBRARIES_URL_KEY)
}
