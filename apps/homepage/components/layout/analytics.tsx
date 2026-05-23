import { GoogleAnalytics } from '@next/third-parties/google'

// Emits the GA4 script only when NEXT_PUBLIC_GA_ID is set, so dev and un-configured deploys stay
// script-free. @next/third-parties handles App Router page-view events on navigation.
export function Analytics() {
    const gaId = process.env.NEXT_PUBLIC_GA_ID
    if (!gaId) return null
    return <GoogleAnalytics gaId={gaId} />
}
