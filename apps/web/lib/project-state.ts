import { ECOSYSTEMS, getEcosystem, groupScanReasons, type EcosystemId, type Locale, type ScanState, type ScanStateSide } from '@sentinello/core'
import type { ProjectCatalogRow } from '@sentinello/db'

// How the dashboard's State column reads a project's scan state.
//
// Lives here rather than in projects-filter-view.tsx because .tsx is outside the coverage globs: the
// decisions below are the ones worth pinning, and in the component they would ship untested.

// Healthy = the project was fully scanned (every expected source answered, every detected ecosystem was
// read) and nothing was found. Anything less is not healthy: a project nothing could read has zero
// findings because nothing looked, and one nothing has scanned yet is unexamined, not clean.
export function isProjectHealthy(row: ProjectCatalogRow, findingCount: number): boolean {
    return row.scanState.state === 'scanned' && findingCount === 0
}

// The State badge: the scan state as one word, or null for a fully scanned project, which shows nothing
// rather than a row of green reassurance.
export function scanStateBadge(state: ScanState): 'cannotScan' | 'partial' | 'notScannedYet' | null {
    if (state.state === 'cannot_scan') return 'cannotScan'
    if (state.state === 'partial') return 'partial'
    if (state.state === 'not_scanned_yet') return 'notScannedYet'
    return null
}

// The badge's tooltip: every reason, labelled in the reader's locale, with whose fix it is — "No lockfile
// (the project) · OSV database not downloaded yet (this Sentinello install) · npm: Has not run yet".
// `sides` carries the two side words in the same locale. A language no enabled source answers for is named
// rather than labelled generically — "No source enabled for Python, Ruby (this Sentinello install)" — and
// `sourceDisabled` is the reader-locale sentence that takes the language names.
export function scanStateReasonsText(
    state: ScanState,
    locale: Locale,
    sides: Record<ScanStateSide, string>,
    sourceDisabled: (languages: string) => string
): string {
    return groupScanReasons(state.reasons, locale).map(function line(group) {
        if (group.side === null) return group.subjects.join(', ') + ': ' + group.label
        const label = group.reasonCode === 'ecosystem_source_disabled' ? sourceDisabled(languageNames(group.subjects)) : group.label
        return label + ' (' + sides[group.side] + ')'
    }).join(' · ')
}

// Ecosystem ids as the languages an operator knows them by — 'PyPI, RubyGems' reads "Python, Ruby". An id
// the registry does not know keeps its id rather than vanishing from the sentence.
export function languageNames(ecosystems: readonly string[]): string {
    return ecosystems.map(function name(id) {
        return getEcosystem(id)?.displayName ?? id
    }).join(', ')
}

// The ecosystems a project has no enabled source for: one ecosystem_source_disabled reason names each.
// Nothing will scan them until the operator turns a source on.
export function sourceDisabledEcosystems(state: ScanState): string[] {
    const out: string[] = []
    for (const reason of state.reasons) {
        if (reason.reasonCode === 'ecosystem_source_disabled' && reason.ecosystem !== null) out.push(reason.ecosystem)
    }
    return out
}

export type ProjectsWithoutSource = {
    // Projects with at least one language no enabled source answers for, each counted once.
    projects: number
    // Per language, how many projects it leaves unscanned, in registry order. Only languages with any.
    ecosystems: { ecosystem: EcosystemId; projects: number }[]
}

// What the dashboard notice and Settings → Sources' "Turn on" actions read: across every project's scan
// state, which languages have detected projects but no enabled source, and how many projects that leaves.
export function projectsWithoutSource(states: Iterable<ScanState>): ProjectsWithoutSource {
    const perEcosystem = new Map<string, number>()
    let projects = 0
    for (const state of states) {
        const ecosystems = sourceDisabledEcosystems(state)
        if (ecosystems.length === 0) continue
        projects += 1
        for (const ecosystem of ecosystems) perEcosystem.set(ecosystem, (perEcosystem.get(ecosystem) ?? 0) + 1)
    }
    const ecosystems: ProjectsWithoutSource['ecosystems'] = []
    for (const eco of ECOSYSTEMS) {
        const count = perEcosystem.get(eco.id)
        if (count !== undefined) ecosystems.push({ ecosystem: eco.id, projects: count })
    }
    return { projects, ecosystems }
}
