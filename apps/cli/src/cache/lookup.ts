import { getEcosystem, type GemnasiumAdvisoryRow, type OsvAdvisoryRow } from '@sentinello/core'
import type { GemnasiumAdvisory, OsvAdvisory } from '@sentinello/scanners'
import { advisoryFilePath, type SourceId } from './meta'
import { readRowsForPackages } from './store'

// Adapts the file-backed cache to the lookup contracts the scanners already declare:
//
//   type OsvLookup = (ecosystem, packageNames) => Map<string, OsvAdvisory[]>
//
// Because that contract is a plain injected function, the CLI needed no scanner changes whatsoever — the
// portal keeps its SQLite-backed implementation and this one reads gzipped ndjson, and the matching engine
// cannot tell the difference. Both therefore produce identical findings for identical inputs, which is
// what makes CLI-versus-portal equivalence a testable property rather than a hope.
//
// The lookups are synchronous because ScannerPlugin.scan calls them inline, so every cache file is read
// once up front and the resolved rows are served from memory for the rest of the run.

export type LoadedCache = {
    osv: Map<string, OsvAdvisory[]>
    gemnasium: Map<string, GemnasiumAdvisory[]>
}

// Reads only the rows matching the packages actually installed. The npm corpus holds ~217k distinct
// package names; a real project resolves under a thousand, so this discards over 99% of the file without
// parsing it.
export async function loadCacheForPackages(
    cacheDir: string,
    ecosystem: string,
    packageNames: readonly string[],
    sources: readonly SourceId[]
): Promise<LoadedCache> {
    const wanted = new Set(packageNames)
    const osv = new Map<string, OsvAdvisory[]>()
    const gemnasium = new Map<string, GemnasiumAdvisory[]>()
    if (sources.includes('osv')) {
        const rows = await readRowsForPackages<OsvAdvisoryRow>(advisoryFilePath(cacheDir, 'osv', ecosystem), wanted)
        for (const [name, list] of rows.entries()) {
            osv.set(name, list.map(toOsvAdvisory))
        }
    }
    if (sources.includes('gemnasium')) {
        const rows = await readRowsForPackages<GemnasiumAdvisoryRow>(advisoryFilePath(cacheDir, 'gemnasium', ecosystem), wanted)
        for (const [name, list] of rows.entries()) {
            gemnasium.set(name, list.map(toGemnasiumAdvisory))
        }
    }
    return { osv, gemnasium }
}

// Resolve the cache's ecosystem key through the registry, mirroring what the worker does: the cache is
// keyed by the canonical OSV id, so a future divergence between internal id and feed id cannot silently
// miss every advisory.
export function cacheEcosystemKey(ecosystem: string): string {
    const def = getEcosystem(ecosystem)
    return def ? def.osvEcosystem : ecosystem
}

function toOsvAdvisory(row: OsvAdvisoryRow): OsvAdvisory {
    return {
        advisoryId: row.advisoryId,
        aliases: row.aliases,
        ranges: row.ranges,
        versions: row.versions,
        severity: row.severity,
        summary: row.summary,
        url: row.url,
        malicious: row.malicious,
        withdrawn: row.withdrawn
    }
}

// gemnasium carries no malware threat class, so GemnasiumAdvisory deliberately has no `malicious` flag —
// the cached row's field is always false and is dropped here rather than invented into the scanner's shape.
function toGemnasiumAdvisory(row: GemnasiumAdvisoryRow): GemnasiumAdvisory {
    return {
        advisoryId: row.advisoryId,
        aliases: row.aliases,
        ranges: row.ranges,
        versions: row.versions,
        severity: row.severity,
        summary: row.summary,
        url: row.url
    }
}
