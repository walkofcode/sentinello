import { getHighlightFor } from '@/lib/release-highlights'
import { getCurrentVersion } from '@/lib/version'
import { WhatsNewPillClient } from './whats-new-pill-client'

// Renders nothing when the running version has no curated highlight entry. getCurrentVersion()
// is server-only (reads env / package.json), so this stays a server component and the pill is
// handed to the client TopNav as a slot prop from app/layout.tsx.
export function WhatsNewPill() {
    const current = getCurrentVersion()
    const meta = getHighlightFor(current)
    if (!meta) return null
    return <WhatsNewPillClient version={meta.version} />
}