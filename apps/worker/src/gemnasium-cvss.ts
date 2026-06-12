// gemnasium advisories ship CVSS *vectors* (cvss_v3 / cvss_v2), not the bucketed severity that OSV/GHSA
// records carry. To produce the same severity vocabulary the matcher consumes (critical/high/moderate/
// low), we compute the CVSS base score from the vector and bucket it per the CVSS spec. v3 is preferred
// when present; v2 is the fallback. Returns null when no usable vector is available — the matcher then
// defaults the finding to 'moderate' rather than silently downgrading.
//
// Implements the CVSS v3.1 and v2.0 base-score formulas (the canonical specs). Only base metrics are
// used; temporal/environmental metrics are ignored (advisories carry base vectors).

const V3_AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }
const V3_AC: Record<string, number> = { L: 0.77, H: 0.44 }
const V3_UI: Record<string, number> = { N: 0.85, R: 0.62 }
const V3_CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 }
const V3_PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 }
const V3_PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 }

const V2_AV: Record<string, number> = { L: 0.395, A: 0.646, N: 1.0 }
const V2_AC: Record<string, number> = { H: 0.35, M: 0.61, L: 0.71 }
const V2_AU: Record<string, number> = { M: 0.45, S: 0.56, N: 0.704 }
const V2_CIA: Record<string, number> = { N: 0, P: 0.275, C: 0.66 }

// Lower-case severity bucket the matcher's mapSeverity() accepts directly.
export function severityFromCvss(cvssV3: string | null, cvssV2: string | null): string | null {
    const v3 = parseVector(cvssV3)
    if (v3) {
        const score = baseScoreV3(v3)
        if (score !== null) return bucketV3(score)
    }
    const v2 = parseVector(cvssV2)
    if (v2) {
        const score = baseScoreV2(v2)
        if (score !== null) return bucketV2(score)
    }
    return null
}

// Splits "CVSS:3.1/AV:N/AC:L/..." or the bare "AV:N/AC:L/Au:N/..." (v2) into a metric→value map.
function parseVector(vector: string | null): Record<string, string> | null {
    if (typeof vector !== 'string' || vector.trim().length === 0) return null
    const out: Record<string, string> = {}
    for (const part of vector.trim().split('/')) {
        const colon = part.indexOf(':')
        if (colon <= 0) continue
        const key = part.slice(0, colon).trim()
        const value = part.slice(colon + 1).trim().toUpperCase()
        if (key === 'CVSS') continue
        out[key] = value
    }
    return Object.keys(out).length > 0 ? out : null
}

// Reads a numeric weight for a metric value, tolerating an absent metric (returns undefined). Needed
// because indexed access into the weight tables is `number | undefined` under strict index checks.
function weight(table: Record<string, number>, key: string | undefined): number | undefined {
    if (key === undefined) return undefined
    return table[key]
}

function baseScoreV3(m: Record<string, string>): number | null {
    const av = weight(V3_AV, m.AV)
    const ac = weight(V3_AC, m.AC)
    const ui = weight(V3_UI, m.UI)
    const c = weight(V3_CIA, m.C)
    const i = weight(V3_CIA, m.I)
    const a = weight(V3_CIA, m.A)
    const changed = m.S === 'C'
    const pr = weight(changed ? V3_PR_CHANGED : V3_PR_UNCHANGED, m.PR)
    if (av === undefined || ac === undefined || ui === undefined || pr === undefined) return null
    if (c === undefined || i === undefined || a === undefined) return null
    const iss = 1 - (1 - c) * (1 - i) * (1 - a)
    const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss
    const exploitability = 8.22 * av * ac * pr * ui
    if (impact <= 0) return 0
    const raw = changed ? 1.08 * (impact + exploitability) : impact + exploitability
    return roundUpV3(Math.min(raw, 10))
}

// CVSS v3.1 "Roundup": round up to one decimal place using integer arithmetic to avoid FP drift.
function roundUpV3(value: number): number {
    const intInput = Math.round(value * 100000)
    if (intInput % 10000 === 0) return intInput / 100000
    return (Math.floor(intInput / 10000) + 1) / 10
}

function bucketV3(score: number): string {
    if (score === 0) return 'none'
    if (score < 4.0) return 'low'
    if (score < 7.0) return 'moderate'
    if (score < 9.0) return 'high'
    return 'critical'
}

function baseScoreV2(m: Record<string, string>): number | null {
    const av = weight(V2_AV, m.AV)
    const ac = weight(V2_AC, m.AC)
    const au = weight(V2_AU, m.Au) ?? weight(V2_AU, m.AU)
    const c = weight(V2_CIA, m.C)
    const i = weight(V2_CIA, m.I)
    const a = weight(V2_CIA, m.A)
    if (av === undefined || ac === undefined || au === undefined) return null
    if (c === undefined || i === undefined || a === undefined) return null
    const impact = 10.41 * (1 - (1 - c) * (1 - i) * (1 - a))
    const exploitability = 20 * av * ac * au
    const f = impact === 0 ? 0 : 1.176
    const base = (0.6 * impact + 0.4 * exploitability - 1.5) * f
    return Math.round(base * 10) / 10
}

// CVSS v2 has no "critical" band; its qualitative map tops out at High.
function bucketV2(score: number): string {
    if (score < 4.0) return 'low'
    if (score < 7.0) return 'moderate'
    return 'high'
}
