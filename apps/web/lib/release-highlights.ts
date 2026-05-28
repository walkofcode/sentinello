export type ReleaseHighlightMeta = {
    version: string
    date: string
}

// Newest first. Adding an entry here REQUIRES a matching WhatsNew.releases.<version>
// block in EVERY apps/web/messages/*.json — next-intl has no fallback configured, so a
// version present here but missing from a catalog renders an error in that locale.
export const RELEASE_HIGHLIGHTS: ReleaseHighlightMeta[] = [
    { version: '1.4.0', date: '2026-06-01' }
]

function stripVPrefix(value: string): string {
    return value.startsWith('v') && value.slice(1) || value
}

export function getAllHighlights(): ReleaseHighlightMeta[] {
    return RELEASE_HIGHLIGHTS
}

export function getLatestHighlight(): ReleaseHighlightMeta | null {
    return RELEASE_HIGHLIGHTS[0] || null
}

export function getHighlightFor(version: string): ReleaseHighlightMeta | null {
    const bare = stripVPrefix(version)
    return RELEASE_HIGHLIGHTS.find(function match(entry) {
        return entry.version === bare
    }) || null
}
