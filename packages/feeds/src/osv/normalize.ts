import type { OsvAdvisoryRow, OsvRange } from '@sentinello/core'
import { compareVersions } from '@sentinello/versions'

// Parses a single OSV record (one *.json file from a per-ecosystem export, or one /v1/vulns response) into
// the denormalized advisory→package rows we cache. One record can affect multiple packages, each with its
// own ranges, so this returns 0..N rows. Only the affected entries for the TARGET ecosystem are kept — the
// caller passes the canonical OSV ecosystem id (e.g. 'npm' | 'PyPI' | 'Go' | 'crates.io') it is syncing,
// because one OSV record can list packages across several ecosystems and each ecosystem is synced
// independently from its own export/cursor (mixing them would let one ecosystem's sync clobber another's).
//
// Two record families matter:
//   - GHSA/CVE : a real advisory with version ranges (introduced/fixed/last_affected events) and a severity
//                bucket. Ranges may be SEMVER (npm/Go/Rust) or ECOSYSTEM (PyPI PEP 440); both are retained.
//   - MAL-xxxx : a malicious package; the whole package is bad (introduced "0", no fix). Flagged
//                `malicious: true` so the scanner and UI treat it as a distinct threat class.

type OsvEvent = { introduced?: string; fixed?: string; last_affected?: string }
type OsvRangeRaw = { type?: string; events?: OsvEvent[] }
type OsvPackage = { name?: string; ecosystem?: string; purl?: string }
// `database_specific` here is the AFFECTED ENTRY's, not the record's (which carries severity/source and is
// read by pickSeverity/pickUrl). GitHub parks a real upper bound in this one whenever it cannot express the
// fix as a `fixed` event — see boundOpenEndedRange.
type OsvAffected = {
    package?: OsvPackage
    ranges?: OsvRangeRaw[]
    versions?: string[]
    database_specific?: { last_known_affected_version_range?: string }
}
type OsvSeverity = { type?: string; score?: string }
type OsvRecord = {
    id?: string
    aliases?: string[]
    summary?: string
    withdrawn?: string
    affected?: OsvAffected[]
    references?: Array<{ type?: string; url?: string }>
    database_specific?: { severity?: string; source?: string }
    severity?: OsvSeverity[]
}

export function normalizeOsvRecord(record: unknown, ecosystem: string): OsvAdvisoryRow[] {
    if (!record || typeof record !== 'object') return []
    const r = record as OsvRecord
    const advisoryId = typeof r.id === 'string' ? r.id : null
    if (!advisoryId) return []
    if (!Array.isArray(r.affected)) return []
    const malicious = advisoryId.startsWith('MAL-')
    const aliases = Array.isArray(r.aliases) ? r.aliases.filter(isNonEmptyString) : []
    const severity = pickSeverity(r)
    const summary = typeof r.summary === 'string' ? r.summary : null
    const url = pickUrl(r, advisoryId)
    const withdrawn = typeof r.withdrawn === 'string' ? Date.parse(r.withdrawn) || null : null
    const rows: OsvAdvisoryRow[] = []
    // One advisory routinely lists the SAME package in several `affected` entries — OSV's normal way of
    // expressing a per-release-branch fix. minimatch GHSA-23c5-xmqv-rm74 ships eight of them (3.x through
    // 10.x), `next` and `ua-parser-js` several each. Every entry's ranges belong to the same package, so
    // they are MERGED into one row here.
    //
    // This used to `continue` past every entry after the first, keeping one branch and silently discarding
    // the rest: 1,927 vulnerable intervals across the npm export alone, each one a real vulnerability the
    // scanner could no longer see. The row key is (advisoryId, ecosystem, packageName), so emitting one row
    // per entry instead would not fix it either — they would collide on upsert and the survivor would still
    // carry a single branch. Merging is what makes the row match every affected branch.
    const byPackage = new Map<string, OsvAdvisoryRow>()
    for (const affected of r.affected) {
        const pkg = affected.package
        // Keep only the ecosystem currently being synced (OSV uses the canonical ids 'npm'/'PyPI'/'Go'/
        // 'crates.io' verbatim in `package.ecosystem`). Other ecosystems are handled by their own sync.
        if (!pkg || pkg.ecosystem !== ecosystem) continue
        const packageName = typeof pkg.name === 'string' ? pkg.name : null
        if (!packageName) continue
        // Parse the real affected set for ALL records, malware included. Malware advisories pin the
        // compromised builds in `versions` (e.g. ["4.4.2"]) and frequently carry a usable range too
        // (e.g. fsevents >=1.0.0 <1.2.11) — discarding either (the old `maliciousRange()` shortcut) is
        // what made the matcher flag clean, remediated versions as compromised.
        const ranges = extractRanges(affected.ranges, affected.database_specific?.last_known_affected_version_range)
        const versions = extractVersions(affected.versions)
        const existing = byPackage.get(packageName)
        if (existing) {
            for (const range of ranges) existing.ranges.push(range)
            for (const version of versions) existing.versions.push(version)
            continue
        }
        byPackage.set(packageName, {
            advisoryId,
            ecosystem,
            packageName,
            aliases,
            ranges,
            versions,
            severity,
            summary,
            url,
            malicious,
            withdrawn
        })
    }
    for (const row of byPackage.values()) {
        // A record we can't match on at all (no range AND no enumerated version) is only worth keeping
        // for malware, where the engine falls back to flag-by-presence; otherwise skip it. Checked after
        // the merge, so a package whose ranges all arrived on a later `affected` entry is kept.
        if (row.ranges.length === 0 && row.versions.length === 0 && !malicious) continue
        rows.push(row)
    }
    return rows
}

function extractVersions(versions: string[] | undefined): string[] {
    if (!Array.isArray(versions)) return []
    const out: string[] = []
    for (const v of versions) {
        if (typeof v === 'string' && v.length > 0) out.push(v)
    }
    return out
}

function extractRanges(ranges: OsvRangeRaw[] | undefined, lastKnownAffected?: string): OsvRange[] {
    if (!Array.isArray(ranges)) return []
    const out: OsvRange[] = []
    for (const range of ranges) {
        // Retain SEMVER (npm/Go/Rust) and ECOSYSTEM (PyPI PEP 440) ranges — the ecosystem's comparator
        // interprets the version strings. GIT ranges carry commit hashes, not versions, and no comparator
        // can evaluate them, so they are dropped (keeping them would only add unmatchable noise).
        const type = typeof range.type === 'string' ? range.type : 'SEMVER'
        if (type !== 'SEMVER' && type !== 'ECOSYSTEM') continue
        if (!Array.isArray(range.events)) continue
        let introduced: string | null = null
        let lastAffected: string | null = null
        for (const event of range.events) {
            if (typeof event.introduced === 'string') {
                // A new `introduced` opens a fresh interval. Flush any prior open interval that only had a
                // last_affected bound (no fixed) before starting the next one.
                if (introduced !== null) {
                    out.push({ type, introduced, fixed: null, lastAffected })
                    lastAffected = null
                }
                introduced = event.introduced
                continue
            }
            if (typeof event.fixed === 'string' && introduced !== null) {
                out.push({ type, introduced, fixed: event.fixed, lastAffected: null })
                introduced = null
                lastAffected = null
                continue
            }
            if (typeof event.last_affected === 'string' && introduced !== null) {
                // Inclusive upper bound with no clean fix — remember it for the current interval.
                lastAffected = event.last_affected
            }
        }
        // A trailing introduced with no fixed = open-ended (or last_affected-bounded) vulnerable range.
        if (introduced !== null) {
            out.push({ type, introduced, fixed: null, lastAffected })
        }
    }
    return boundOpenEndedRange(out.filter(canMatchSomething), lastKnownAffected)
}

// Whether an interval can ever match a version. `fixed` is EXCLUSIVE, so `[X, X)` admits nothing and
// `[2.0.0, 1.0.0)` admits less than nothing — both are advisory rows that sit in the cache looking live and
// can never report, which is the same silent failure the PEP 440 comma bug had on the gemnasium side.
//
// The gemnasium normalizer has had this check since it grew inclusive upper bounds (isEmptyInterval), and
// OSV not having one was an asymmetry rather than a decision: the two sources feed the same matcher and
// disagreed about what a degenerate interval means. Both now drop it.
//
// Zero rows in a 227k-row npm/PyPI/Go/crates.io export trip either test, because OSV's schema requires
// events in ascending order and the exports honour it. It is written for the input that does not, which
// OSV.dev's aggregation of many upstream databases makes a question of when rather than whether.
//
// The equality test is ordering-FREE and so applies to every range type: two identical strings are the same
// version under any ecosystem's rules. The ordering test is not, and is therefore SEMVER-only —
// compareVersions is semver, and using it on a PEP 440 range would mis-order the very spellings PEP 440
// exists to express (1.0.post1, 1!2.0), dropping real advisories. Reporting a dead range is a bug; deleting
// a live one is a worse bug, so the uncertain case keeps the range.
function canMatchSomething(range: OsvRange): boolean {
    if (typeof range.fixed !== 'string') return true
    if (range.fixed === range.introduced) return false
    return range.type !== 'SEMVER' || compareVersions(range.fixed, range.introduced) > 0
}

// Close a range that has no upper bound at all, using the boundary GitHub parks in the affected entry's
// `database_specific.last_known_affected_version_range`.
//
// GitHub will not emit a `fixed` event naming a version that is not published under that package name on
// the registry, so for those advisories it states the range as `events: [{introduced: '0'}]` — affecting
// every version ever released — and writes the real boundary here instead. It is not an edge case, it is
// what happens whenever the fix lives somewhere the registry cannot serve: SheetJS moved xlsx 0.19.x+ to
// cdn.sheetjs.com (GHSA-4r6h-8v6p-xvw6 `< 0.19.3`, GHSA-5pgg-2g8v-p4x9 `< 0.20.2`), `babel-traverse`
// 7.23.2 exists only under the renamed `@babel/traverse` (GHSA-67hx-6x53-jw92), `sandbox` 1.0.0 was never
// published. Dropping it reported 22 findings across 11 projects against a fully patched xlsx 0.20.3, with
// no fix version to act on — while npm-audit, reading the same GitHub data through the registry's audit
// endpoint, reported the same two advisories correctly as `<0.19.3` and `<0.20.2`.
//
// FALLBACK ONLY, never a supplement. On a multi-branch record the field is not the whole truth:
// GHSA-25hc-qcg6-38wj says `< 2.5.0` while its real branch fixes are 2.5.1 AND 4.6.2, so letting it touch
// an entry that already states a bound would narrow a correct range into a false negative. Hence both
// gates — one range only (a single bound cannot close two intervals, and picking which one to close is the
// arbitrary choice that produced the protobufjs regression on the gemnasium side), and that range open.
//
// The grammar is one upper bound, `< X` or `<= X`. Anything else is refused rather than best-guessed: the
// two forms were measured across a sample, not the whole 227k-row export, so an unseen shape must leave the
// range exactly as it is — reporting a too-wide range is the behaviour we already have, while inventing a
// bound from a string we misread would hide a real vulnerability. The `<= X` arm is exercised by tests
// only; in the export it always co-occurs with a real `fixed` event, which the open-range gate then skips.
// It is written because it is the field's stated grammar, not because a record has been seen to need it.
function boundOpenEndedRange(ranges: OsvRange[], lastKnownAffected: string | undefined): OsvRange[] {
    if (ranges.length !== 1 || typeof lastKnownAffected !== 'string') return ranges
    const text = lastKnownAffected.trim()
    const inclusive = text.startsWith('<=')
    if (!inclusive && !text.startsWith('<')) return ranges
    const version = text.slice(inclusive ? 2 : 1).trim()
    // A leftover separator means the string is a compound range, not the single bound this reads.
    if (version.length === 0 || /[\s,|]/.test(version)) return ranges
    const out: OsvRange[] = []
    for (const range of ranges) {
        const open = range.fixed === null && range.lastAffected === null
        // Spread rather than rebuild: `range.type` has to survive, because the matcher drops an untyped
        // range whenever the OSV scanner filters by accepted range type.
        out.push(open ? { ...range, fixed: inclusive ? null : version, lastAffected: inclusive ? version : null } : range)
    }
    return out
}

// GHSA records carry the severity bucket in database_specific.severity (e.g. "MODERATE"). Some records
// only ship a CVSS vector under severity[] — we ignore those here and let the scanner default, since
// computing a bucket from a vector is out of scope for the cache.
function pickSeverity(r: OsvRecord): string | null {
    const ds = r.database_specific && r.database_specific.severity
    if (typeof ds === 'string' && ds.length > 0) return ds
    return null
}

function pickUrl(r: OsvRecord, advisoryId: string): string | null {
    if (Array.isArray(r.references)) {
        const advisory = r.references.find(function isAdvisory(ref) {
            return ref.type === 'ADVISORY' && isNonEmptyString(ref.url)
        })
        if (advisory && advisory.url) return advisory.url
        const web = r.references.find(function hasUrl(ref) {
            return isNonEmptyString(ref.url)
        })
        if (web && web.url) return web.url
    }
    if (r.database_specific && isNonEmptyString(r.database_specific.source)) {
        return r.database_specific.source as string
    }
    return 'https://osv.dev/vulnerability/' + advisoryId
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0
}
