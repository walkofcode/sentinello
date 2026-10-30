// The central Language × Source registry — the single contract every layer binds to (Phase 2 / Issue
// #005). Language slugs, OSV ecosystem ids, gemnasium package types, resolver lockfile kinds,
// comparators, config-key slugs, and UI labels are NOT interchangeable and must NOT be re-derived ad
// hoc per phase. OSV's per-ecosystem exports live at gs://osv-vulnerabilities/<osvEcosystem>/all.zip
// where <osvEcosystem> is the canonical OSV id ('PyPI', 'Go', 'crates.io' — not a lowercase slug), so a
// slug used where an OSV id is expected 404s the feed; and resolver output keyed by a different
// ecosystem string than the advisory rows silently fails to match. One table prevents that class of bug:
// OSV sync, gemnasium parsing, resolver routing, comparator routing, and the UI matrix all import this.

import { comparatorById, normalizePyName, type ComparatorId, type VersionComparator } from '@sentinello/versions'
import type { PackageManager, ProjectManifest } from './types'

// Canonical ecosystem id == the OSV feed dir == the value persisted in findings/mutes/etc. and used as
// the config-key slug. 'npm' is JavaScript. Whether each one is offered to operators is its `status`.
export type EcosystemId = 'npm' | 'PyPI' | 'Go' | 'crates.io' | 'RubyGems'

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

export type EcosystemLanguage = 'javascript' | 'python' | 'go' | 'rust' | 'ruby'

// Whether an ecosystem is finished enough to be offered to an operator.
//
// 'preview' is not a soft warning — it removes the ecosystem from the product surface entirely: its cells
// are absent from Settings → Sources, getSourceEnabled refuses them even if a config key says otherwise,
// discovery does not look for its manifests, and no advisory export is downloaded for it. The registry
// still describes it in full, so promoting one is this single field and nothing else.
//
// An ecosystem is promoted only once its matching is proven, not merely implemented — a source that answers
// "no vulnerabilities" for the wrong reason is worse than one that is not offered. Python, Go, Rust and Ruby
// were promoted in 3.8, once their own comparators, range dialects and fix derivation were proven by the
// generated corpus sweeps (packages/scanners/src/version-fix-corpus.test.ts,
// packages/feeds/src/gemnasium/range-fidelity.test.ts) and the product around the matching was in place:
// discovery inside a project, one finding across several manifests, the marker for an ecosystem no enabled
// source answers for, and fix verification against their own registries. No ecosystem is in preview today;
// the state stays for the next one.
export type EcosystemStatus = 'stable' | 'preview'

export type EcosystemDefinition = {
    // Stable internal id / config-key slug / persisted value / OSV feed dir. e.g. 'npm'.
    id: EcosystemId
    language: EcosystemLanguage
    // UI label, e.g. 'Node.js'.
    displayName: string
    // Whether this ecosystem is offered to operators at all — see EcosystemStatus.
    status: EcosystemStatus
    // Canonical OSV feed dir, e.g. 'npm' | 'PyPI' | 'Go' | 'crates.io'. Built into the OSV export path.
    osvEcosystem: string
    // gemnasium-db package-type directory name.
    gemnasiumPackageType: string
    // Lockfile kinds the resolver routes on, in preference order: within one directory the first present wins.
    resolverKinds: string[]
    // Manifests that declare dependencies without pinning them. Found with no lockfile covering it, one is
    // reported as `no_lockfile` for its ecosystem instead of being silently omitted — coverage honesty only,
    // nothing is ever resolved from its unlocked constraints. Go has none: go.mod is its own build list.
    manifestKinds: string[]
    // The VersionComparator every reader of this ecosystem's versions orders them with.
    comparator: ComparatorId
    // Whether the way out of a finding with no fixed version released is computed (parent upgrades proven
    // against each release's dependency closure, package health, curated alternatives). It needs the
    // registry's per-version dependency metadata, which only npm's client reads (SENTINEL-119); every other
    // ecosystem's way out is one `unknown` verdict saying so, and no surface shows a health block for it.
    wayOut: boolean
    // The registry its fix versions are checked against, as a sentence names it: "not on the npm registry".
    registryName: string
}

export const ECOSYSTEMS: EcosystemDefinition[] = [
    {
        id: 'npm',
        language: 'javascript',
        // The registry ecosystem is npm and the toolchain is Node — 'JavaScript' overclaimed, naming a
        // language rather than the package ecosystem actually scanned.
        displayName: 'Node.js',
        status: 'stable',
        osvEcosystem: 'npm',
        gemnasiumPackageType: 'npm',
        resolverKinds: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
        manifestKinds: ['package.json'],
        comparator: 'semver',
        wayOut: true,
        registryName: 'the npm registry'
    },
    {
        id: 'PyPI',
        language: 'python',
        displayName: 'Python',
        status: 'stable',
        osvEcosystem: 'PyPI',
        gemnasiumPackageType: 'pypi',
        resolverKinds: ['poetry.lock', 'Pipfile.lock', 'requirements.txt', 'uv.lock'],
        manifestKinds: ['pyproject.toml', 'Pipfile'],
        comparator: 'pep440',
        wayOut: false,
        registryName: 'PyPI'
    },
    {
        id: 'Go',
        language: 'go',
        displayName: 'Go',
        status: 'stable',
        osvEcosystem: 'Go',
        gemnasiumPackageType: 'go',
        resolverKinds: ['go.mod', 'go.sum'],
        manifestKinds: [],
        comparator: 'go',
        wayOut: false,
        registryName: 'the Go module proxy'
    },
    {
        id: 'crates.io',
        language: 'rust',
        displayName: 'Rust',
        status: 'stable',
        osvEcosystem: 'crates.io',
        gemnasiumPackageType: 'cargo',
        resolverKinds: ['Cargo.lock'],
        manifestKinds: ['Cargo.toml'],
        comparator: 'semver',
        wayOut: false,
        registryName: 'the crates.io index'
    },
    {
        id: 'RubyGems',
        language: 'ruby',
        displayName: 'Ruby',
        status: 'stable',
        osvEcosystem: 'RubyGems',
        gemnasiumPackageType: 'gem',
        resolverKinds: ['Gemfile.lock'],
        manifestKinds: ['Gemfile'],
        comparator: 'rubygems',
        wayOut: false,
        registryName: 'rubygems.org'
    }
]

// The ecosystem every pre-polyglot row is backfilled to. Centralized so no caller re-types the 'npm'
// literal.
export const DEFAULT_ECOSYSTEM: EcosystemId = 'npm'

// The ecosystems actually offered to operators. Every surface that ENUMERATES ecosystems — the Sources
// matrix, manifest discovery, the per-cell config reader — walks this rather than ECOSYSTEMS, so a preview
// ecosystem cannot be configured, scanned, downloaded for, or reported on. Lookups by id (getEcosystem,
// ecosystemForOsvId) deliberately still resolve preview entries: rows persisted by an earlier build have
// to stay readable and correctly labelled.
export const STABLE_ECOSYSTEMS: EcosystemDefinition[] = ECOSYSTEMS.filter(function stable(eco) {
    return eco.status === 'stable'
})

export function isEcosystemStable(id: string): boolean {
    const def = getEcosystem(id)
    return def !== null && def.status === 'stable'
}

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

// A persisted or user-supplied ecosystem id narrowed to the registry's type, failing loudly on one the
// registry does not know. Used where a finding identity is written: an unknown id there is a defect in the
// caller, and writing it would create a finding no cell, mute or filter can ever address.
export function requireEcosystemId(id: string): EcosystemId {
    const def = getEcosystem(id)
    if (def === null) throw new Error('unknown ecosystem ' + JSON.stringify(id))
    return def.id
}

// Whether a finding of this ecosystem gets a computed way out (EcosystemDefinition.wayOut); false for an id
// the registry does not know.
export function computesWayOut(ecosystem: string): boolean {
    return getEcosystem(ecosystem)?.wayOut === true
}

export function getEcosystem(id: string): EcosystemDefinition | null {
    for (const eco of ECOSYSTEMS) {
        if (eco.id === id) return eco
    }
    return null
}

// The name a package is keyed on, in every advisory store and every resolved graph. PyPI names are
// case- and separator-insensitive (PEP 503), so they are keyed canonical; every other registry's names are
// exact, and a different spelling there is a different package.
export function canonicalPackageName(ecosystem: string, name: string): string {
    return ecosystem === 'PyPI' ? normalizePyName(name) : name
}

// The comparator an ecosystem's versions are ordered with, or null for an id the registry does not know —
// which callers must treat as "cannot reason about these versions", never as a reason to fall back to
// semver. The one ecosystem → comparator lookup: the matcher, the feed normalizers, the fix picker and the
// portal all go through it.
export function comparatorForEcosystem(ecosystem: string): VersionComparator | null {
    const def = getEcosystem(ecosystem)
    return def === null ? null : comparatorById(def.comparator)
}

// The same, for a reader that holds a persisted ecosystem id, where an unknown one is a defect in the data
// rather than a case to handle: every stored row carries a registered id (the boot backfill sees to the
// legacy ones). Fails loudly instead of ordering its versions under some other ecosystem's rules.
export function requireComparator(ecosystem: string): VersionComparator {
    const comparator = comparatorForEcosystem(ecosystem)
    if (comparator === null) throw new Error('no version comparator for unknown ecosystem ' + JSON.stringify(ecosystem))
    return comparator
}

// Resolve a canonical OSV feed id (e.g. 'PyPI') back to its ecosystem definition. Used by OSV sync /
// lookup where rows are keyed by the OSV ecosystem string rather than the internal id.
export function ecosystemForOsvId(osvEcosystem: string): EcosystemDefinition | null {
    for (const eco of ECOSYSTEMS) {
        if (eco.osvEcosystem === osvEcosystem) return eco
    }
    return null
}

// The ecosystem key an OSV-derived advisory cache is stored under. Both the CLI's on-disk cache and the
// worker's osv.db are keyed by the canonical OSV id, so resolving through the registry here is what stops
// a future divergence between internal id and feed id silently matching nothing.
//
// Lives in core because it had been written out twice — once exported and tested in the CLI, once inlined
// in the worker's lookup closure where nothing reached its unregistered-ecosystem arm.
export function cacheEcosystemKey(ecosystem: string): string {
    const def = getEcosystem(ecosystem)
    return def ? def.osvEcosystem : ecosystem
}

// The package manager each manifest or lockfile kind belongs to. A manifest no lockfile pins a manager for
// (a package.json with none, a pyproject.toml on its own, which pip, Poetry and uv all read) is 'unknown'.
const MANIFEST_PACKAGE_MANAGERS: Record<string, PackageManager> = {
    'package-lock.json': 'npm',
    'pnpm-lock.yaml': 'pnpm',
    'yarn.lock': 'yarn',
    'package.json': 'unknown',
    'poetry.lock': 'poetry',
    'Pipfile.lock': 'pipenv',
    'Pipfile': 'pipenv',
    'requirements.txt': 'pip',
    'uv.lock': 'uv',
    'pyproject.toml': 'unknown',
    'go.mod': 'go',
    'go.sum': 'go',
    'Cargo.lock': 'cargo',
    'Cargo.toml': 'cargo',
    'Gemfile.lock': 'bundler',
    'Gemfile': 'bundler'
}

export function packageManagerOfManifest(kind: string): PackageManager {
    return MANIFEST_PACKAGE_MANAGERS[kind] ?? 'unknown'
}

// The managers a project's manifests name, in manifest order and each once, for the project card
// (`pnpm · bundler`). An 'unknown' manager says nothing and is left out.
export function projectPackageManagers(manifests: readonly ProjectManifest[]): PackageManager[] {
    const out: PackageManager[] = []
    for (const manifest of manifests) {
        const manager = packageManagerOfManifest(manifest.kind)
        if (manager !== 'unknown' && !out.includes(manager)) out.push(manager)
    }
    return out
}
