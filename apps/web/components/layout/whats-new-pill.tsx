import { getReleaseFor } from '@sentinello/core'
import { getCurrentVersion } from '@/lib/version'
import { WhatsNewPillClient } from './whats-new-pill-client'

// Renders nothing when the running version has no curated release entry. getCurrentVersion()
// is server-only (reads env / package.json), so this stays a server component and the pill is
// handed to the client TopNav as a slot prop from app/layout.tsx.
export function WhatsNewPill() {
    const meta = getReleaseFor(getCurrentVersion())
    if (!meta) return null
    return <WhatsNewPillClient version={meta.version} />
}