import type { VersionComparator } from '../types'

// The Python-ecosystem version comparator (PEP 440). PyPI versions are NOT semver — they have epochs
// (`1!2.0`), implicit-zero release padding (`1.0` == `1.0.0`), pre-releases (`a`/`b`/`rc` with the
// alpha/beta/c/pre/preview spellings), post-releases (`.post1`, `-1`), dev-releases (`.dev1`), and local
// versions (`+ubuntu1`). Comparing them with semver rules silently mis-orders, which is exactly why the
// registry routes PyPI here instead of reusing the semver comparator. This is a focused, self-contained
// reimplementation of the ordering in PyPA's `packaging.version._cmpkey` (no runtime dependency added).

// Sort rank of the normalized pre-release letter: alpha < beta < release-candidate.
const PRE_RANK: Record<string, number> = { a: 0, b: 1, rc: 2 }

type Pep440 = {
    epoch: number
    release: number[]
    // Normalized pre-release: letter is one of 'a' | 'b' | 'rc' (alpha/beta/c/pre/preview folded in).
    pre: { letter: string; n: number } | null
    post: number | null
    dev: number | null
    // Local version segments: numeric parts as numbers, alphanumeric parts as lower-cased strings.
    local: Array<number | string> | null
}

// PEP 440 grammar (case-insensitive, optional leading `v`, optional surrounding whitespace). Named groups
// mirror the canonical appendix regex; the post-release `-N` shorthand is captured separately as postN1.
const PEP440_RE = new RegExp(
    '^\\s*v?' +
        '(?:(?<epoch>[0-9]+)!)?' +
        '(?<release>[0-9]+(?:\\.[0-9]+)*)' +
        '(?:[-_.]?(?<preL>a|b|c|rc|alpha|beta|pre|preview)[-_.]?(?<preN>[0-9]+)?)?' +
        '(?:(?:-(?<postN1>[0-9]+))|(?:[-_.]?(?<postL>post|rev|r)[-_.]?(?<postN2>[0-9]+)?))?' +
        '(?:[-_.]?(?<devL>dev)[-_.]?(?<devN>[0-9]+)?)?' +
        '(?:\\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?' +
        '\\s*$',
    'i'
)

function foldPreLetter(raw: string): string {
    const l = raw.toLowerCase()
    if (l === 'alpha') return 'a'
    if (l === 'beta') return 'b'
    if (l === 'c' || l === 'pre' || l === 'preview' || l === 'rc') return 'rc'
    return l
}

export function parsePep440(raw: string): Pep440 | null {
    const m = PEP440_RE.exec(raw.trim())
    if (!m || !m.groups) return null
    const g = m.groups
    if (!g.release) return null
    const release = g.release.split('.').map(function toInt(s) {
        return parseInt(s, 10)
    })
    if (release.some(function bad(n) { return Number.isNaN(n) })) return null

    let pre: Pep440['pre'] = null
    if (g.preL) {
        pre = { letter: foldPreLetter(g.preL), n: g.preN ? parseInt(g.preN, 10) : 0 }
    }

    let post: number | null = null
    if (g.postN1 !== undefined) {
        post = parseInt(g.postN1, 10)
    } else if (g.postL) {
        post = g.postN2 ? parseInt(g.postN2, 10) : 0
    }

    const dev: number | null = g.devL ? (g.devN ? parseInt(g.devN, 10) : 0) : null

    let local: Pep440['local'] = null
    if (g.local) {
        local = g.local.toLowerCase().split(/[-_.]/).map(function part(seg) {
            return /^[0-9]+$/.test(seg) ? parseInt(seg, 10) : seg
        })
    }

    return { epoch: g.epoch ? parseInt(g.epoch, 10) : 0, release, pre, post, dev, local }
}

// Drop trailing zero segments so `1.0` and `1.0.0` compare equal (PEP 440 release tuples are not
// significant in their trailing zeros).
function stripTrailingZeros(release: number[]): number[] {
    let end = release.length
    while (end > 1 && release[end - 1] === 0) end--
    return release.slice(0, end)
}

// Lexicographic numeric tuple compare; a prefix is less than its extension (so 1 < 1.0.1).
function cmpRelease(a: number[], b: number[]): number {
    const ra = stripTrailingZeros(a)
    const rb = stripTrailingZeros(b)
    const len = Math.max(ra.length, rb.length)
    for (let i = 0; i < len; i++) {
        const x = ra[i] ?? 0
        const y = rb[i] ?? 0
        if (x !== y) return x < y ? -1 : 1
    }
    return 0
}

// Pre-release ordering rank. A dev-only release (no pre, no post) sorts BEFORE any pre-release; a final
// release (no pre) sorts AFTER any pre-release. Returns a kind (-1 below, 0 real pre, 1 above) so the kinds
// alone order the sentinels, and ties within kind 0 fall through to the letter/number compare.
function preKind(v: Pep440): number {
    if (v.pre !== null) return 0
    if (v.post === null && v.dev !== null) return -1
    return 1
}

function cmpPre(a: Pep440, b: Pep440): number {
    const ka = preKind(a)
    const kb = preKind(b)
    if (ka !== kb) return ka < kb ? -1 : 1
    if (ka !== 0 || !a.pre || !b.pre) return 0
    const la = PRE_RANK[a.pre.letter] ?? 0
    const lb = PRE_RANK[b.pre.letter] ?? 0
    if (la !== lb) return la < lb ? -1 : 1
    if (a.pre.n !== b.pre.n) return a.pre.n < b.pre.n ? -1 : 1
    return 0
}

// post: absent sorts below any post number (a final release < its post-releases).
function cmpPost(a: number | null, b: number | null): number {
    if (a === null && b === null) return 0
    if (a === null) return -1
    if (b === null) return 1
    return a < b ? -1 : a > b ? 1 : 0
}

// dev: absent sorts ABOVE any dev number (a dev release < its eventual final release).
function cmpDev(a: number | null, b: number | null): number {
    if (a === null && b === null) return 0
    if (a === null) return 1
    if (b === null) return -1
    return a < b ? -1 : a > b ? 1 : 0
}

// local: absent sorts below any local; numeric segments outrank string segments at the same position.
function cmpLocal(a: Array<number | string> | null, b: Array<number | string> | null): number {
    if (a === null && b === null) return 0
    if (a === null) return -1
    if (b === null) return 1
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++) {
        if (i >= a.length) return -1
        if (i >= b.length) return 1
        const x = a[i]
        const y = b[i]
        const xNum = typeof x === 'number'
        const yNum = typeof y === 'number'
        if (xNum && yNum) {
            if (x !== y) return (x as number) < (y as number) ? -1 : 1
        } else if (xNum !== yNum) {
            // A numeric segment outranks a string segment.
            return xNum ? 1 : -1
        } else if (x !== y) {
            return (x as string) < (y as string) ? -1 : 1
        }
    }
    return 0
}

function comparePep440(a: Pep440, b: Pep440): number {
    if (a.epoch !== b.epoch) return a.epoch < b.epoch ? -1 : 1
    const r = cmpRelease(a.release, b.release)
    if (r !== 0) return r
    const p = cmpPre(a, b)
    if (p !== 0) return p
    const po = cmpPost(a.post, b.post)
    if (po !== 0) return po
    const d = cmpDev(a.dev, b.dev)
    if (d !== 0) return d
    return cmpLocal(a.local, b.local)
}

// VersionComparator over PEP 440. `normalize` returns the trimmed input when it parses (and null when it
// can't, so the matcher skips it — never a false positive); gte/lt re-parse and compare with the full
// ordering. gte/lt assume normalized (parseable) inputs from the matcher; a parse miss yields a safe false.
export const pep440Comparator: VersionComparator = {
    normalize(raw: string): string | null {
        return parsePep440(raw) === null ? null : raw.trim()
    },
    gte(a: string, b: string): boolean {
        const pa = parsePep440(a)
        const pb = parsePep440(b)
        if (!pa || !pb) return false
        return comparePep440(pa, pb) >= 0
    },
    lt(a: string, b: string): boolean {
        const pa = parsePep440(a)
        const pb = parsePep440(b)
        if (!pa || !pb) return false
        return comparePep440(pa, pb) < 0
    }
}
