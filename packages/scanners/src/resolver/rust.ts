import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeGraph } from './graph'
import { parseArrayOfTables } from './toml-lite'
import type { ResolvedPackage, ResolverResult } from './types'

// Rust resolver. `Cargo.lock` pins the FULL resolved dependency graph (every crate + exact version), so it
// resolves to an `ok` graph — the offline-complete case. Cargo.lock carries no prod/dev distinction, so we
// read the sibling `Cargo.toml`'s `[dev-dependencies]` to mark direct dev crates as dev; everything else
// (including all transitives) is treated as prod, which keeps real findings visible. Crate names are the
// OSV crates.io key as-is; semver versions are handled by the semver comparator (Rust rides semver).

const CRATES_ECOSYSTEM = 'crates.io'

export async function parseCargoLock(projectPath: string, absolutePath: string): Promise<ResolverResult> {
    let text: string
    try {
        text = await readFile(absolutePath, 'utf8')
    } catch {
        return { status: 'unauditable', ecosystem: CRATES_ECOSYSTEM, reasonCode: 'unsupported_lockfile', details: ['could not read Cargo.lock'] }
    }
    const devNames = await readDevDependencyNames(projectPath)
    const tables = parseArrayOfTables(text, 'package')
    const out: ResolvedPackage[] = []
    for (const t of tables) {
        const name = typeof t.name === 'string' ? t.name : null
        const version = typeof t.version === 'string' ? t.version : null
        if (!name || !version) continue
        // A package with no `source` is the workspace's own crate (path member / the root), not a
        // registry dependency — skip it so the local crate isn't audited as a third-party dep.
        if (typeof t.source !== 'string' || t.source.length === 0) continue
        const isDev = devNames.has(name)
        out.push({
            ecosystem: CRATES_ECOSYSTEM,
            name,
            version,
            scope: { isProd: !isDev, isDev, isOptional: false },
            depPaths: [name + '@' + version]
        })
    }
    if (out.length === 0) {
        return { status: 'unauditable', ecosystem: CRATES_ECOSYSTEM, reasonCode: 'ambiguous_dependency_spec', details: ['no registry packages found in Cargo.lock'] }
    }
    return { status: 'ok', ecosystem: CRATES_ECOSYSTEM, graph: makeGraph(out) }
}

// Best-effort scan of Cargo.toml's `[dev-dependencies]` table for the direct dev crate names. Handles both
// `crate = "1.0"` and `crate = { version = "1.0" }` forms; absence of Cargo.toml just means "all prod".
async function readDevDependencyNames(projectPath: string): Promise<Set<string>> {
    const names = new Set<string>()
    let text: string
    try {
        text = await readFile(join(projectPath, 'Cargo.toml'), 'utf8')
    } catch {
        return names
    }
    let inDev = false
    for (const rawLine of text.split(/\r?\n/)) {
        const line = stripComment(rawLine).trim()
        if (line.length === 0) continue
        if (line.startsWith('[')) {
            // `[dev-dependencies]` and target-specific `[target.'cfg(...)'.dev-dependencies]` both count.
            inDev = line.includes('dev-dependencies')
            continue
        }
        if (!inDev) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const name = line.slice(0, eq).trim()
        if (name.length > 0) names.add(name)
    }
    return names
}

function stripComment(line: string): string {
    const idx = line.indexOf('#')
    return idx >= 0 ? line.slice(0, idx) : line
}
