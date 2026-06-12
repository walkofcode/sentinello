// The central Language × Source registry — the single contract every layer binds to (Phase 2 / Issue
// #005). Language slugs, OSV ecosystem ids, gemnasium package types, resolver lockfile kinds,
// comparators, config-key slugs, and UI labels are NOT interchangeable and must NOT be re-derived ad
// hoc per phase. OSV's per-ecosystem exports live at gs://osv-vulnerabilities/<osvEcosystem>/all.zip
// where <osvEcosystem> is the canonical OSV id ('PyPI', 'Go', 'crates.io' — not a lowercase slug), so a
// slug used where an OSV id is expected 404s the feed; and resolver output keyed by a different
// ecosystem string than the advisory rows silently fails to match. One table prevents that class of bug:
// OSV sync, gemnasium parsing, resolver routing, comparator routing, and the UI matrix all import this.

// Canonical ecosystem id == the OSV feed dir == the value persisted in findings/mutes/etc. and used as
// the config-key slug. 'npm' is JavaScript. Today only 'npm' is live; the other three are the
// architected-for menu that Phases 3–4 light up.
export type EcosystemId = 'npm' | 'PyPI' | 'Go' | 'crates.io'

// The persisted source identity (distinct from the scanner *plugin* name, which stays an implementation
// detail inside the scanners package). For the current sources source === scanner name; they are modeled
// as separate fields because a (source, ecosystem) cell is two orthogonal axes (Issue #004).
export type SourceId = 'npm-audit' | 'osv' | 'gemnasium'

// A configuration/visibility/notification unit: one advisory source answering for one ecosystem.
// Persisted as two separate fields, never a fused 'osv-python' string.
export type SourceCell = {
    source: SourceId
    ecosystem: EcosystemId
}

export type EcosystemLanguage = 'javascript' | 'python' | 'go' | 'rust'

export type EcosystemDefinition = {
    // Stable internal id / config-key slug / persisted value / OSV feed dir. e.g. 'npm'.
    id: EcosystemId
    language: EcosystemLanguage
    // UI label, e.g. 'JavaScript'.
    displayName: string
    // Canonical OSV feed dir, e.g. 'npm' | 'PyPI' | 'Go' | 'crates.io'. Built into the OSV export path.
    osvEcosystem: string
    // gemnasium-db package-type directory name.
    gemnasiumPackageType: string
    // Lockfile kinds the resolver routes on.
    resolverKinds: string[]
    // VersionComparator id, e.g. 'semver' | 'pep440'.
    comparator: string
}

export const ECOSYSTEMS: EcosystemDefinition[] = [
    {
        id: 'npm',
        language: 'javascript',
        displayName: 'JavaScript',
        osvEcosystem: 'npm',
        gemnasiumPackageType: 'npm',
        resolverKinds: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
        comparator: 'semver'
    },
    {
        id: 'PyPI',
        language: 'python',
        displayName: 'Python',
        osvEcosystem: 'PyPI',
        gemnasiumPackageType: 'pypi',
        resolverKinds: ['poetry.lock', 'Pipfile.lock', 'requirements.txt', 'uv.lock'],
        comparator: 'pep440'
    },
    {
        id: 'Go',
        language: 'go',
        displayName: 'Go',
        osvEcosystem: 'Go',
        gemnasiumPackageType: 'go',
        resolverKinds: ['go.mod', 'go.sum'],
        comparator: 'semver'
    },
    {
        id: 'crates.io',
        language: 'rust',
        displayName: 'Rust',
        osvEcosystem: 'crates.io',
        gemnasiumPackageType: 'cargo',
        resolverKinds: ['Cargo.lock'],
        comparator: 'semver'
    }
]

// The ecosystem every pre-polyglot row is backfilled to, and the value the worker stamps until Phases
// 3–4 light up non-npm resolvers. Centralized so no caller re-types the 'npm' literal.
export const DEFAULT_ECOSYSTEM: EcosystemId = 'npm'

// Every known source id, ordered by dedup priority (npm-audit authoritative first). Mirrors the worker's
// selectScanners ordering so config, visibility, and scan order all agree.
export const SOURCE_IDS: SourceId[] = ['npm-audit', 'osv', 'gemnasium']

// A source descriptor for the UI matrix and any layer that needs to know which ecosystems a source can
// answer for. The Languages × Sources Settings page renders cells from (ECOSYSTEMS × SOURCES) filtered by
// `supportedEcosystems`, so npm-audit only appears under JavaScript while OSV/gemnasium appear under every
// language. `defaultEnabled` mirrors the db's SOURCE_DEFAULT_ENABLED (npm-audit on, the cache-backed
// sources off) so the matrix shows the same default an unset cell resolves to.
export type SourceDefinition = {
    id: SourceId
    // UI label, e.g. 'npm audit'.
    displayName: string
    // The ecosystems this source can answer for. null === every ecosystem (OSV/gemnasium are polyglot);
    // npm-audit is JavaScript-only.
    supportedEcosystems: EcosystemId[] | null
    // Whether an unset (source, ecosystem) cell defaults enabled.
    defaultEnabled: boolean
    // Whether the source downloads/keeps a local advisory cache (OSV, gemnasium) vs. running live
    // (npm-audit). Drives whether the matrix shows sync status / provisioning disclosure for the cell.
    cacheBacked: boolean
}

export const SOURCES: SourceDefinition[] = [
    { id: 'npm-audit', displayName: 'npm audit', supportedEcosystems: ['npm'], defaultEnabled: true, cacheBacked: false },
    { id: 'osv', displayName: 'OSV', supportedEcosystems: null, defaultEnabled: false, cacheBacked: true },
    { id: 'gemnasium', displayName: 'GitLab gemnasium', supportedEcosystems: null, defaultEnabled: false, cacheBacked: true }
]

export function getSource(id: string): SourceDefinition | null {
    for (const source of SOURCES) {
        if (source.id === id) return source
    }
    return null
}

export function sourceSupportsEcosystem(source: SourceId, ecosystem: EcosystemId): boolean {
    const def = getSource(source)
    if (!def) return false
    return def.supportedEcosystems === null || def.supportedEcosystems.includes(ecosystem)
}

// The source ids that can answer for one ecosystem, in SOURCE_IDS (dedup-priority) order.
export function sourcesForEcosystem(ecosystem: EcosystemId): SourceId[] {
    const out: SourceId[] = []
    for (const source of SOURCES) {
        if (sourceSupportsEcosystem(source.id, ecosystem)) out.push(source.id)
    }
    return out
}

export function getEcosystem(id: string): EcosystemDefinition | null {
    for (const eco of ECOSYSTEMS) {
        if (eco.id === id) return eco
    }
    return null
}

// Resolve a canonical OSV feed id (e.g. 'PyPI') back to its ecosystem definition. Used by OSV sync /
// lookup where rows are keyed by the OSV ecosystem string rather than the internal id.
export function ecosystemForOsvId(osvEcosystem: string): EcosystemDefinition | null {
    for (const eco of ECOSYSTEMS) {
        if (eco.osvEcosystem === osvEcosystem) return eco
    }
    return null
}
