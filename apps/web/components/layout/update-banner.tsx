import { getVersionInfo } from '@/lib/version'
import { UpdateBannerClient } from './update-banner-client'

// Rendered on every page via app/layout.tsx between TopNav and main.
// getVersionInfo() is module-level cached (see lib/version.ts), so this
// shares the result with <SiteFooter /> — no extra GitHub request.

export async function UpdateBanner() {
    const info = await getVersionInfo()
    if (!info.updateAvailable || !info.latest) return null
    const releaseUrl = info.releaseUrl || 'https://github.com/walkofcode/sentinello/releases'
    return <UpdateBannerClient version={info.latest} releaseUrl={releaseUrl} />
}
