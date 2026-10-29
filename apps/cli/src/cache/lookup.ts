import { osvNormalizerVersion, type GemnasiumAdvisoryRow, type OsvAdvisoryRow } from '@sentinello/core'
import { stampWithdrawnByPackage, type GemnasiumAdvisory, type OsvAdvisory } from '@sentinello/scanners'
import { advisoryFilePath, isSeeded, type CacheMeta, type SourceId } from './meta'
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
    // Whether the gemnasium advisories were stamped from a complete OSV snapshot. False means an advisory
    // GitHub has withdrawn may still be listed; the run says so rather than refusing the scan.
    withdrawalsChecked: boolean
}

// Reads only the rows matching the packages actually installed. The npm corpus holds ~217k distinct
// package names; a real project resolves under a thousand, so this discards over 99% of the file without
// parsing it.
//
// The OSV file is also gemnasium's withdrawal evidence, so it is read whenever gemnasium is selected,
// whether or not OSV is, but only when its meta says it is complete at the current normalizer version: a
// partial or old-shape file could hold a withdrawn duplicate without its active twin and drop a live
// advisory. A refresh never leaves a partial file behind: refreshOsv rewrites it only once every changed
// advisory was re-read, so a seeded file is always a complete snapshot.
export async function loadCacheForPackages(
    cacheDir: string,
    ecosystem: string,
    packageNames: readonly string[],
    sources: readonly SourceId[],
    meta: CacheMeta
): Promise<LoadedCache> {
    const wanted = new Set(packageNames)
    const osv = new Map<string, OsvAdvisory[]>()
    const gemnasium = new Map<string, GemnasiumAdvisory[]>()
    const withGemnasium = sources.includes('gemnasium')
    const evidenceComplete = withGemnasium && isSeeded(meta, 'osv', ecosystem, osvNormalizerVersion(ecosystem))
    let osvRows = new Map<string, OsvAdvisoryRow[]>()
    if (sources.includes('osv') || evidenceComplete) {
        osvRows = await readRowsForPackages<OsvAdvisoryRow>(advisoryFilePath(cacheDir, 'osv', ecosystem), wanted)
    }
    if (sources.includes('osv')) {
        for (const [name, list] of osvRows.entries()) {
            osv.set(name, list.map(toOsvAdvisory))
        }
    }
    if (withGemnasium) {
        const rows = await readRowsForPackages<GemnasiumAdvisoryRow>(advisoryFilePath(cacheDir, 'gemnasium', ecosystem), wanted)
        for (const [name, list] of rows.entries()) {
            gemnasium.set(name, list.map(toGemnasiumAdvisory))
        }
    }
    return {
        osv,
        gemnasium: evidenceComplete ? stampWithdrawnByPackage(gemnasium, osvRows) : gemnasium,
        withdrawalsChecked: evidenceComplete
    }
}

// Moved to @sentinello/core so the worker's OSV lookup shares this one implementation instead of
// carrying an inlined copy. Re-exported here because this module is where the CLI reaches for it.
export { cacheEcosystemKey } from '@sentinello/core'

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
// Its `withdrawn` is always null in gemnasium-db; loadCacheForPackages stamps it from the OSV evidence.
function toGemnasiumAdvisory(row: GemnasiumAdvisoryRow): GemnasiumAdvisory {
    return {
        advisoryId: row.advisoryId,
        aliases: row.aliases,
        ranges: row.ranges,
        versions: row.versions,
        severity: row.severity,
        summary: row.summary,
        url: row.url,
        withdrawn: null
    }
}
