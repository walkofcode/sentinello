import type { EcosystemId } from './ecosystems'
import type { SourceCell } from './ecosystems'

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
    cells?: undefined
} | OperatorBaseline

// The same silence when an operator switches a source on: enabling OSV for Python would otherwise send every
// finding that existed all along, one project at a time. Its row in capability_baselines is the source of truth,
// and it covers exactly its (source, ecosystem) cells: findings another source reports for that language are not
// news of the same kind, and npm can be one of its cells.
export type OperatorBaseline = {
    id: string
    since: null
    ecosystems: EcosystemId[]
    cells: SourceCell[]
}

// Whether a baseline holds back a new finding of this source and ecosystem.
export function baselineCovers(capability: Capability, source: string, ecosystem: string): boolean {
    if (capability.cells === undefined) return (capability.ecosystems as string[]).includes(ecosystem)
    return capability.cells.some(function sameCell(cell) { return cell.source === source && cell.ecosystem === ecosystem })
}

export const CAPABILITIES: Capability[] = [
    { id: 'languages-3.8', since: '3.8.0', ecosystems: ['PyPI', 'Go', 'crates.io', 'RubyGems'] }
]
