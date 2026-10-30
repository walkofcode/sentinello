import type { EcosystemId } from './ecosystems'

// A capability one release adds to a running install: something that, once it is switched on, would
// report findings that existed all along. The first scan after an upgrade that adds one is a silent
// baseline for it — its findings are recorded without one notification each, and every enabled target
// receives exactly one summary instead — so an upgrade never floods every channel with old news.
//
// Appended to, never edited: an id is the durable key of its baseline state. 3.9 adds its runtimes here.
export type Capability = {
    id: string
    // The release that introduced it, for the summary's wording.
    since: string
    // The finding ecosystems whose new findings the baseline records silently. npm is never one of them:
    // npm findings notify as they always have, during the baseline too.
    ecosystems: EcosystemId[]
}

export const CAPABILITIES: Capability[] = [
    { id: 'languages-3.8', since: '3.8.0', ecosystems: ['PyPI', 'Go', 'crates.io', 'RubyGems'] }
]
