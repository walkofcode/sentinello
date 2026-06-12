import { readFile } from 'node:fs/promises'
import { makeGraph } from './graph'
import { parseArrayOfTables } from './toml-lite'
import type { DepScope, ResolvedPackage, ResolverResult } from './types'

// Python (PyPI) resolver. True lockfiles (poetry.lock / Pipfile.lock / uv.lock) pin exact versions, so
// they resolve to an `ok` graph; `requirements.txt` is a free-form install list that may mix `==` pins
// with ranges, unpinned names, `-e` editables, `-r`/`-c` includes, and environment markers — we scan only
// the `==`-pinned subset and classify the result `partial`/`unauditable` so coverage is never overstated.
// Package names are normalized to their PEP 503 canonical form (lower-case, runs of `-_.` collapsed to a
// single `-`) to match how OSV keys PyPI advisories.

const PYPI_ECOSYSTEM = 'PyPI'

export function normalizePyName(name: string): string {
    return name.trim().toLowerCase().replace(/[-_.]+/g, '-')
}

export async function parsePythonLock(kind: string, absolutePath: string): Promise<ResolverResult> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return unauditable('unsupported_lockfile', ['could not read ' + kind])
    }
    if (kind === 'poetry.lock') return fromTomlLock(text, true)
    if (kind === 'uv.lock') return fromTomlLock(text, false)
    if (kind === 'Pipfile.lock') return fromPipfileLock(text)
    if (kind === 'requirements.txt') return fromRequirements(text)
    return unauditable('unsupported_lockfile', ['unsupported Python manifest: ' + kind])
}

// poetry.lock (with a `category` field on older versions to split main/dev) and uv.lock (no scope info)
// are both arrays-of-tables with `name`/`version`. uv.lock carries no group info, so everything is prod.
function fromTomlLock(text: string, hasCategory: boolean): ResolverResult {
    const tables = parseArrayOfTables(text, 'package')
    const out: ResolvedPackage[] = []
    for (const t of tables) {
        const name = strVal(t.name)
        const version = strVal(t.version)
        if (!name || !version) continue
        const isDev = hasCategory && strVal(t.category) === 'dev'
        out.push(pkg(name, version, { isProd: !isDev, isDev, isOptional: strVal(t.optional) === 'true' }))
    }
    if (out.length === 0) return unauditable('ambiguous_dependency_spec', ['no packages found in lockfile'])
    return { status: 'ok', ecosystem: PYPI_ECOSYSTEM, graph: makeGraph(out) }
}

type PipfileLock = {
    default?: Record<string, { version?: string }>
    develop?: Record<string, { version?: string }>
}

// Pipfile.lock is JSON: `default` (prod) + `develop` (dev), each name → { version: "==1.2.3" }. Pipenv
// normally pins every entry; any non-`==` version (e.g. "*") makes the result partial.
function fromPipfileLock(text: string): ResolverResult {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return unauditable('unsupported_lockfile', ['Pipfile.lock is not valid JSON'])
    }
    if (!parsed || typeof parsed !== 'object') return unauditable('unsupported_lockfile', ['Pipfile.lock is not an object'])
    const doc = parsed as PipfileLock
    const out: ResolvedPackage[] = []
    let ambiguous = 0
    collectPipfileGroup(doc.default, false, out, function onAmbiguous() { ambiguous++ })
    collectPipfileGroup(doc.develop, true, out, function onAmbiguous() { ambiguous++ })
    if (out.length === 0) return unauditable('ambiguous_dependency_spec', ['no pinned packages in Pipfile.lock'])
    if (ambiguous > 0) {
        return { status: 'partial', ecosystem: PYPI_ECOSYSTEM, graph: makeGraph(out), reasonCode: 'partial_dependency_graph', details: [ambiguous + ' Pipfile.lock entries were not pinned to an exact version'] }
    }
    return { status: 'ok', ecosystem: PYPI_ECOSYSTEM, graph: makeGraph(out) }
}

function collectPipfileGroup(
    group: Record<string, { version?: string }> | undefined,
    isDev: boolean,
    out: ResolvedPackage[],
    onAmbiguous: () => void
): void {
    if (!group || typeof group !== 'object') return
    for (const name of Object.keys(group)) {
        const raw = group[name] && typeof group[name].version === 'string' ? String(group[name].version) : ''
        const version = exactPin(raw)
        if (version === null) {
            onAmbiguous()
            continue
        }
        out.push(pkg(name, version, { isProd: !isDev, isDev, isOptional: false }))
    }
}

// requirements.txt: scan only `==`-pinned lines. Ranged/unpinned/editable/include/marker-gated lines make
// the result partial (we scan the pinned subset); if nothing is pinnable the file is unauditable.
function fromRequirements(text: string): ResolverResult {
    const out: ResolvedPackage[] = []
    let ambiguous = 0
    for (const rawLine of text.split(/\r?\n/)) {
        const line = stripReqComment(rawLine).trim()
        if (line.length === 0) continue
        // Options/includes/editables: `-r other.txt`, `-c constraints.txt`, `-e .`, `--hash=...` lines.
        if (line.startsWith('-')) {
            ambiguous++
            continue
        }
        const parsed = parseRequirementLine(line)
        if (!parsed) {
            ambiguous++
            continue
        }
        out.push(pkg(parsed.name, parsed.version, { isProd: true, isDev: false, isOptional: false }))
        // A line that pins but is gated by an environment marker we can't evaluate offline still counts as
        // covered (we surface it conservatively) but flags partial so the limit is disclosed.
        if (parsed.markerGated) ambiguous++
    }
    if (out.length === 0) return unauditable('ambiguous_dependency_spec', ['requirements.txt has no exact (==) version pins'])
    if (ambiguous > 0) {
        return { status: 'partial', ecosystem: PYPI_ECOSYSTEM, graph: makeGraph(out), reasonCode: 'partial_dependency_graph', details: [ambiguous + ' requirements.txt lines were ranged, unpinned, included, editable, or marker-gated and were not audited'] }
    }
    return { status: 'ok', ecosystem: PYPI_ECOSYSTEM, graph: makeGraph(out) }
}

type RequirementLine = { name: string; version: string; markerGated: boolean }

function parseRequirementLine(line: string): RequirementLine | null {
    // Strip an environment marker (`; python_version < "3.8"`) but remember it gated the install.
    const semi = line.indexOf(';')
    const markerGated = semi >= 0
    const spec = (markerGated ? line.slice(0, semi) : line).trim()
    // Only exact pins. `==` (and the arbitrary-equality `===`) are the auditable operators; a `*` wildcard
    // version (`==1.2.*`) is not exact. Everything else (>=, ~=, !=, <, bare name) is not a pin.
    const eq = spec.indexOf('==')
    if (eq < 0) return null
    const rawName = spec.slice(0, eq).trim()
    let version = spec.slice(eq + 2).trim()
    if (version.startsWith('=')) version = version.slice(1).trim() // `===arbitrary`
    if (version.length === 0 || version.includes('*')) return null
    // Strip extras: `requests[security]` → `requests`.
    const bracket = rawName.indexOf('[')
    const baseName = bracket >= 0 ? rawName.slice(0, bracket) : rawName
    if (baseName.length === 0 || !/^[A-Za-z0-9._-]+$/.test(baseName)) return null
    return { name: baseName, version, markerGated }
}

function stripReqComment(line: string): string {
    const idx = line.indexOf('#')
    return idx >= 0 ? line.slice(0, idx) : line
}

// Strip a leading `==` / `===` from a Pipfile.lock version string; null when it isn't an exact pin.
function exactPin(raw: string): string | null {
    const s = raw.trim()
    if (s.startsWith('===')) return s.slice(3).trim() || null
    if (s.startsWith('==')) {
        const v = s.slice(2).trim()
        return v.length > 0 && !v.includes('*') ? v : null
    }
    return null
}

function pkg(name: string, version: string, scope: DepScope): ResolvedPackage {
    return { ecosystem: PYPI_ECOSYSTEM, name: normalizePyName(name), version, scope, depPaths: [name] }
}

function strVal(value: string | string[] | undefined): string | null {
    return typeof value === 'string' ? value : null
}

function unauditable(reasonCode: 'unsupported_lockfile' | 'ambiguous_dependency_spec', details: string[]): ResolverResult {
    return { status: 'unauditable', ecosystem: PYPI_ECOSYSTEM, reasonCode, details }
}
