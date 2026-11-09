import { and, eq, inArray, isNull } from 'drizzle-orm'
import { parseFindingCorroborations, type FindingCorroboration } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { findings } from '../schema'

// Which advisory a finding row is, across sources. Two rows of one (ecosystem, package) are the same advisory
// when their ids or aliases intersect, directly or through other rows: npm-audit's numeric id with the GHSA in
// its URL, OSV's GHSA listing the CVE, gemnasium's CVE. A generic title is no evidence at all: u-root's two
// path-traversal CVEs share one and are two advisories (SENTINEL-174).
//
// Union-find per (ecosystem, package) across every open row of every project, retained failed-source and
// disabled-cell rows included, since a row nobody re-read still needs the same key as its live twin. Without
// evidence two rows of one vulnerability stay split rather than falsely merged.

// What a feed cache knows about a package's advisories: its ids and aliases. Null when the cache cannot be read
// yet, which means stored evidence only, and the cache landing refreshes it.
export type AliasEvidence = (ecosystem: string, packageNames: string[]) => ReadonlyMap<string, readonly { advisoryId: string; aliases: readonly string[] }[]> | null

export type AdvisoryPackage = { ecosystem: string; packageName: string }

export type RefreshAdvisoryKeysResult = {
    written: number
    // The key of every open row read, by finding id.
    keys: Map<string, string>
}

type OpenRow = {
    id: string
    source: string | null
    scanner: string
    ecosystem: string
    packageName: string
    advisoryId: string
    advisoryUrl: string | null
    aliasesJson: string
    corroborationsJson: string
    advisoryKey: string | null
}

// An id is globally named when it carries its namespace (GHSA-…, CVE-…, GO-…, RUSTSEC-…, PYSEC-…, GMS-…). One
// that does not, like npm-audit's numeric ids, is only unique inside its source: namespaced, so a bare
// number can never join two advisories.
function nodeOf(id: string, source: string): string {
    return /^[A-Za-z]+-/.test(id) ? id.toLowerCase() : source + ':' + id.toLowerCase()
}

const URL_IDENTIFIERS = /\b(GHSA(?:-[0-9a-z]{4}){3}|CVE-\d{4}-\d{4,})\b/gi

function urlIdentifiers(url: string | null): string[] {
    return url === null ? [] : [...url.matchAll(URL_IDENTIFIERS)].map(function id(match) { return match[1] as string })
}

function parseAliases(json: string): string[] {
    let parsed: unknown
    try {
        parsed = JSON.parse(json)
    } catch {
        return []
    }
    return Array.isArray(parsed) ? parsed.filter(function isId(value): value is string { return typeof value === 'string' && value.length > 0 }) : []
}

class UnionFind {
    private readonly parents = new Map<string, string>()

    find(node: string): string {
        let root = node
        for (let parent = this.parents.get(root); parent !== undefined && parent !== root; parent = this.parents.get(root)) root = parent
        if (!this.parents.has(node)) this.parents.set(node, node)
        this.parents.set(node, root)
        return root
    }

    union(a: string, b: string): void {
        const rootA = this.find(a)
        const rootB = this.find(b)
        if (rootA !== rootB) this.parents.set(rootB, rootA)
    }

    nodes(): string[] {
        return [...this.parents.keys()]
    }
}

// GHSA, then CVE, then the lowest id: whatever order the rows came in, a component has one representative.
function representative(nodes: readonly string[]): string {
    function rank(node: string): number {
        if (node.startsWith('ghsa-')) return 0
        if (node.startsWith('cve-')) return 1
        return 2
    }
    return [...nodes].sort(function best(a, b) { return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0) })[0] as string
}

// The keys of one (ecosystem, package)'s open rows, from their stored evidence and what the caches know.
function keysOfPackage(rows: readonly OpenRow[], cacheRecords: readonly { advisoryId: string; aliases: readonly string[] }[]): Map<string, string> {
    const sets = new UnionFind()
    const rowNodes = new Map<string, string>()
    for (const row of rows) {
        const source = row.source ?? row.scanner
        const node = nodeOf(row.advisoryId, source)
        rowNodes.set(row.id, node)
        sets.find(node)
        for (const alias of [...parseAliases(row.aliasesJson), ...urlIdentifiers(row.advisoryUrl)]) sets.union(node, nodeOf(alias, source))
        for (const c of parseFindingCorroborations(row.corroborationsJson) as FindingCorroboration[]) sets.union(node, nodeOf(c.advisoryId, c.source))
    }
    // A cache record has no source of its own to namespace with, and needs none: only globally named ids link
    // anything across records. An unnamed one in a cache is the cache's private id, and is left out.
    for (const record of cacheRecords) {
        const named = [record.advisoryId, ...record.aliases].filter(function isNamed(id) { return /^[A-Za-z]+-/.test(id) }).map(function lower(id) { return id.toLowerCase() })
        for (let i = 1; i < named.length; i++) sets.union(named[0] as string, named[i] as string)
    }
    const byRoot = new Map<string, string[]>()
    for (const node of sets.nodes()) {
        const root = sets.find(node)
        const list = byRoot.get(root)
        if (list) list.push(node)
        else byRoot.set(root, [node])
    }
    const keys = new Map<string, string>()
    for (const [id, node] of rowNodes) keys.set(id, representative(byRoot.get(sets.find(node)) as string[]))
    return keys
}

// Refreshes advisory_key for the open rows of the named packages, or of every package with no scope. Writes
// only the rows whose key changed.
export function refreshAdvisoryKeys(db: DrizzleDb, caches: readonly AliasEvidence[], scope?: readonly AdvisoryPackage[]): RefreshAdvisoryKeysResult {
    const groups = new Map<string, OpenRow[]>()
    for (const row of readOpenRows(db, scope)) {
        const key = row.ecosystem + '\x00' + row.packageName
        const group = groups.get(key)
        if (group) group.push(row)
        else groups.set(key, [row])
    }
    const names = new Map<string, string[]>()
    for (const group of groups.values()) {
        const first = group[0] as OpenRow
        const list = names.get(first.ecosystem)
        if (list) list.push(first.packageName)
        else names.set(first.ecosystem, [first.packageName])
    }
    const answers = new Map<string, ReadonlyMap<string, readonly { advisoryId: string; aliases: readonly string[] }[]>[]>()
    for (const [ecosystem, packageNames] of names) {
        const read: ReadonlyMap<string, readonly { advisoryId: string; aliases: readonly string[] }[]>[] = []
        for (const cache of caches) {
            const answer = cache(ecosystem, packageNames)
            if (answer !== null) read.push(answer)
        }
        answers.set(ecosystem, read)
    }
    const keys = new Map<string, string>()
    let written = 0
    db.transaction(function write(tx) {
        for (const group of groups.values()) {
            const first = group[0] as OpenRow
            const records = (answers.get(first.ecosystem) as ReadonlyMap<string, readonly { advisoryId: string; aliases: readonly string[] }[]>[]).flatMap(function ofPackage(answer) { return [...(answer.get(first.packageName) ?? [])] })
            const groupKeys = keysOfPackage(group, records)
            for (const row of group) {
                const key = groupKeys.get(row.id) as string
                keys.set(row.id, key)
                if (row.advisoryKey === key) continue
                tx.update(findings).set({ advisoryKey: key }).where(eq(findings.id, row.id)).run()
                written += 1
            }
        }
    })
    return { written, keys }
}

function readOpenRows(db: DrizzleDb, scope: readonly AdvisoryPackage[] | undefined): OpenRow[] {
    const columns = {
        id: findings.id,
        source: findings.source,
        scanner: findings.scanner,
        ecosystem: findings.ecosystem,
        packageName: findings.packageName,
        advisoryId: findings.advisoryId,
        advisoryUrl: findings.advisoryUrl,
        aliasesJson: findings.aliasesJson,
        corroborationsJson: findings.corroborationsJson,
        advisoryKey: findings.advisoryKey
    }
    if (scope === undefined) return db.select(columns).from(findings).where(isNull(findings.resolvedAt)).all()
    const wanted = new Set(scope.map(function pair(p) { return p.ecosystem + '\x00' + p.packageName }))
    const out: OpenRow[] = []
    const names = [...new Set(scope.map(function name(p) { return p.packageName }))]
    const CHUNK = 500
    for (let i = 0; i < names.length; i += CHUNK) {
        const rows = db.select(columns).from(findings).where(and(isNull(findings.resolvedAt), inArray(findings.packageName, names.slice(i, i + CHUNK)))).all()
        for (const row of rows) {
            if (wanted.has(row.ecosystem + '\x00' + row.packageName)) out.push(row)
        }
    }
    return out
}
