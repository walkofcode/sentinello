// One-off audit: read every row in `findings` (dumped to JSON), check whether
// the stored fix_version makes sense given installed_version and vulnerable_range,
// and what the new picker would suggest. Read-only.
//
// Usage:
//   sqlite3 ./data/sentinello.sqlite -json "SELECT id, package_name, installed_version, vulnerable_range, fix_version, fix_available, advisory_id FROM findings" > /tmp/sentinello-findings.json
//   cd packages/scanners && node ../../scripts/audit-fix-versions.mjs

import { readFileSync } from 'node:fs'
import { Range, satisfies, gte, gt, valid, coerce } from 'semver'

const JSON_PATH = '/tmp/sentinello-findings.json'
const VERSION_LITERAL_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g

function parseRangeSafely(input) {
    if (!input) return null
    const trimmed = String(input).trim()
    if (!trimmed) return null
    if (trimmed === '<0.0.0') return null
    try {
        return new Range(trimmed, { includePrerelease: false })
    } catch {
        return null
    }
}

function extractLiteralCandidates(input) {
    if (!input) return []
    const matches = String(input).match(VERSION_LITERAL_RE)
    if (!matches) return []
    const out = []
    for (const m of matches) {
        if (valid(m)) out.push(m)
    }
    return out
}

function bumpPatch(v) {
    const sv = coerce(v)
    if (!sv) return null
    return sv.major + '.' + sv.minor + '.' + (sv.patch + 1)
}

function extractRangeLowerBounds(range) {
    const out = []
    for (const conjuncts of range.set) {
        let candidate = null
        for (const c of conjuncts) {
            if (!c.semver || !c.semver.version) continue
            const v = c.semver.version
            if (!valid(v)) continue
            const op = c.operator
            if (op === '>=' || op === '=' || op === '') {
                if (!candidate || gt(v, candidate)) candidate = v
            } else if (op === '>') {
                const inc = bumpPatch(v)
                if (inc && (!candidate || gt(inc, candidate))) candidate = inc
            }
        }
        if (candidate) out.push(candidate)
    }
    return out
}

function extractRangeUpperBoundsBeyond(range) {
    const out = []
    for (const conjuncts of range.set) {
        for (const c of conjuncts) {
            if (!c.semver || !c.semver.version) continue
            const v = c.semver.version
            if (!valid(v)) continue
            const op = c.operator
            if (op === '<') {
                out.push(v)
            } else if (op === '<=') {
                const inc = bumpPatch(v)
                if (inc) out.push(inc)
            }
        }
    }
    return out
}

function pickHighestInstalled(installed) {
    if (!installed) return null
    const parts = String(installed).split(/[\s,]+/)
    let highest = null
    for (const raw of parts) {
        const part = raw.trim()
        if (!part) continue
        if (!valid(part)) continue
        if (!highest || gt(part, highest)) highest = part
    }
    return highest
}

function pickSafeFixVersion(args) {
    const patchedRange = parseRangeSafely(args.patched)
    const vulnRange = parseRangeSafely(args.vulnerable)
    const installedFloor = pickHighestInstalled(args.installed)
    const candidates = new Set()
    if (patchedRange) {
        for (const v of extractRangeLowerBounds(patchedRange)) candidates.add(v)
    } else {
        for (const v of extractLiteralCandidates(args.patched)) candidates.add(v)
    }
    for (const v of extractLiteralCandidates(args.recommendation)) candidates.add(v)
    if (vulnRange) {
        for (const v of extractRangeUpperBoundsBeyond(vulnRange)) candidates.add(v)
    }
    for (const v of extractLiteralCandidates(args.vulnerable)) candidates.add(v)
    if (candidates.size === 0) return null
    let best = null
    for (const v of candidates) {
        if (patchedRange && !satisfies(v, patchedRange)) continue
        if (vulnRange && satisfies(v, vulnRange)) continue
        if (installedFloor && !gte(v, installedFloor)) continue
        if (!best || gt(best, v)) best = v
    }
    return best
}

const rows = JSON.parse(readFileSync(JSON_PATH, 'utf-8'))

const buckets = {
    OK: 0,
    WRONG_STILL_VULNERABLE: 0,
    WRONG_DOWNGRADE: 0,
    MISSING_BUT_COMPUTABLE: 0,
    MISSING_NO_CANDIDATE: 0,
    UNPARSEABLE_VULN_RANGE_NO_FIX: 0,
    INSTALLED_NOT_VULNERABLE_AND_FIX_OK: 0,
    INSTALLED_IS_RANGE: 0,
    FIX_NOT_VALID_SEMVER: 0
}

const rescanOutcome = {
    UNCHANGED: 0,
    REPLACED_BOGUS_WITH_NULL: 0,
    REPLACED_BOGUS_WITH_BETTER: 0,
    ADDED_NEW_FIX: 0,
    CHANGED_VALUE: 0,
    STILL_NO_FIX: 0,
    STORED_FIX_BUT_RECOMPUTE_NULL: 0
}

const samples = {
    WRONG_STILL_VULNERABLE: [],
    WRONG_DOWNGRADE: [],
    MISSING_BUT_COMPUTABLE: [],
    UNPARSEABLE_VULN_RANGE_NO_FIX: [],
    INSTALLED_IS_RANGE: [],
    FIX_NOT_VALID_SEMVER: []
}

const SAMPLE_LIMIT = 10

function pushSample(bucket, row, extra) {
    if (samples[bucket] && samples[bucket].length < SAMPLE_LIMIT) {
        samples[bucket].push({ ...row, ...extra })
    }
}

for (const row of rows) {
    const installed = row.installed_version || ''
    const vuln = row.vulnerable_range || ''
    const fix = row.fix_version
    const vulnRange = parseRangeSafely(vuln)
    const installedFloor = pickHighestInstalled(installed)
    const installedLooksLikeRange = installed && !installedFloor

    // Diagnose the STORED row
    let storedVerdict = 'OK'
    if (installedLooksLikeRange) {
        buckets.INSTALLED_IS_RANGE++
        pushSample('INSTALLED_IS_RANGE', row, {})
        if (fix && valid(fix) && vulnRange && satisfies(fix, vulnRange)) {
            buckets.WRONG_STILL_VULNERABLE++
            pushSample('WRONG_STILL_VULNERABLE', row, { note: 'installed is range' })
            storedVerdict = 'WRONG'
        }
    } else if (fix) {
        if (!valid(fix)) {
            buckets.FIX_NOT_VALID_SEMVER++
            pushSample('FIX_NOT_VALID_SEMVER', row, {})
            storedVerdict = 'WRONG'
        } else {
            const stillVuln = vulnRange && satisfies(fix, vulnRange)
            const downgrade = installedFloor && !gte(fix, installedFloor)
            if (stillVuln) {
                buckets.WRONG_STILL_VULNERABLE++
                pushSample('WRONG_STILL_VULNERABLE', row, {})
                storedVerdict = 'WRONG'
            } else if (downgrade) {
                buckets.WRONG_DOWNGRADE++
                pushSample('WRONG_DOWNGRADE', row, {})
                storedVerdict = 'WRONG'
            } else {
                buckets.OK++
            }
        }
    } else {
        const wouldCompute = pickSafeFixVersion({ patched: null, recommendation: null, vulnerable: vuln, installed: installed || null })
        if (wouldCompute) {
            buckets.MISSING_BUT_COMPUTABLE++
            pushSample('MISSING_BUT_COMPUTABLE', row, { computed: wouldCompute })
        } else if (!vulnRange) {
            buckets.UNPARSEABLE_VULN_RANGE_NO_FIX++
            pushSample('UNPARSEABLE_VULN_RANGE_NO_FIX', row, {})
        } else {
            buckets.MISSING_NO_CANDIDATE++
        }
    }

    // What would the NEW picker produce on re-scan? (using only vuln+installed
    // since we don't have the original patched/recommendation strings)
    const recomputed = pickSafeFixVersion({ patched: null, recommendation: null, vulnerable: vuln, installed: installed || null })
    if (fix && recomputed === fix) {
        rescanOutcome.UNCHANGED++
    } else if (fix && recomputed === null && storedVerdict === 'WRONG') {
        rescanOutcome.REPLACED_BOGUS_WITH_NULL++
    } else if (fix && recomputed === null && storedVerdict === 'OK') {
        rescanOutcome.STORED_FIX_BUT_RECOMPUTE_NULL++
    } else if (fix && recomputed !== null && storedVerdict === 'WRONG') {
        rescanOutcome.REPLACED_BOGUS_WITH_BETTER++
    } else if (fix && recomputed !== null && recomputed !== fix) {
        rescanOutcome.CHANGED_VALUE++
    } else if (!fix && recomputed !== null) {
        rescanOutcome.ADDED_NEW_FIX++
    } else if (!fix && recomputed === null) {
        rescanOutcome.STILL_NO_FIX++
    }
}

console.log('Total rows scanned:', rows.length)
console.log('')
console.log('=== STORED-ROW DIAGNOSIS (what is in the DB right now) ===')
console.log('')
console.log('Bucket counts:')
const ordering = ['OK', 'WRONG_STILL_VULNERABLE', 'WRONG_DOWNGRADE', 'MISSING_BUT_COMPUTABLE', 'MISSING_NO_CANDIDATE', 'UNPARSEABLE_VULN_RANGE_NO_FIX', 'INSTALLED_IS_RANGE', 'FIX_NOT_VALID_SEMVER']
for (const name of ordering) {
    const count = buckets[name]
    const pct = rows.length === 0 ? '0.0' : ((count / rows.length) * 100).toFixed(1)
    console.log('  ' + name.padEnd(36) + String(count).padStart(7) + '  (' + pct + '%)')
}
console.log('')

for (const bucket of Object.keys(samples)) {
    const items = samples[bucket]
    if (items.length === 0) continue
    console.log('--- Samples: ' + bucket + ' (up to ' + SAMPLE_LIMIT + ') ---')
    for (const s of items) {
        const computed = s.computed ? ' -> computed=' + s.computed : ''
        const note = s.note ? ' [' + s.note + ']' : ''
        console.log('  ' + s.package_name + '  installed=' + s.installed_version + '  vuln=' + s.vulnerable_range + '  fix=' + (s.fix_version || 'null') + computed + note)
    }
    console.log('')
}

console.log('=== RE-SCAN SIMULATION (what new picker produces using only vuln+installed) ===')
console.log('Caveat: the live scanner has the original patched_versions/recommendation strings;')
console.log('this simulation only sees what the DB stored. Real re-scan will be at least this good.')
console.log('')
const rescanOrdering = ['UNCHANGED', 'REPLACED_BOGUS_WITH_NULL', 'REPLACED_BOGUS_WITH_BETTER', 'ADDED_NEW_FIX', 'CHANGED_VALUE', 'STILL_NO_FIX', 'STORED_FIX_BUT_RECOMPUTE_NULL']
for (const name of rescanOrdering) {
    const count = rescanOutcome[name]
    const pct = rows.length === 0 ? '0.0' : ((count / rows.length) * 100).toFixed(1)
    console.log('  ' + name.padEnd(36) + String(count).padStart(7) + '  (' + pct + '%)')
}
