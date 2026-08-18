import { describe, expect, it } from 'vitest'
import { gte, satisfies, valid, Range } from 'semver'
import { pickSafeFixVersion } from './version-fix'

// EXHAUSTIVE INVARIANT SWEEP over the "upgrade to X" advice — the third source's range surface, and the
// completion of the argument made in packages/feeds/src/{gemnasium,osv}/range-grammar.test.ts.
//
// npm-audit does not parse ranges of its own: it carries npm's `range` string through verbatim, and this
// function turns that string into the version shown beside a finding. So npm-audit's range semantics live
// here, and the failure modes are the mirror image of the ones on the feed side:
//
//   - npm/fresh GMS-2017-232 was a finding with NO fix (`fixAvailable: false`), which is what a range
//     collapsed onto its own fix boundary produces. Unfixable-by-construction is the tell.
//   - The opposite, and the worse one, is a fix that does not fix: advice to upgrade to a version still
//     inside the vulnerable range closes a finding while leaving the vulnerability in place.
//
// version-fix.test.ts beside this file asserts what specific inputs return, which is the right shape for
// pinning intended behaviour. This file asserts what NO input may return. Neither statement is derivable
// from the other, and the second one is the one that survives an input nobody imagined.

// Real vulnerable-range spellings as npm and pnpm emit them, plus the shapes that broke the feed parsers.
const VULNERABLE = [
    '<0.5.2',
    '< 0.5.2',
    '<=0.3.3',
    '>1.2.8',
    '>=1.0.0 <2.0.0',
    '>=1.0.0 <=1.9.9',
    '>1.0.0 <2.0.0',
    '<4.17.21',
    '>=3.0.0 <3.0.6 || <2.6.3',
    '>=1.0.0',
    '*',
    '<0.0.0',
    '1.0.0 - 2.0.0',
    '^1.0.0',
    '~1.2.0',
    '',
    'not a range',
    '>=7.0.0 <7.6.5 || >=8.0.0 <8.0.1'
] as const

const PATCHED = [null, '>=0.5.2', '>=2.0.0', '2.0.0', '>=1.9.9', 'nonsense', ''] as const
const RECOMMENDED = [null, '0.5.2', '2.0.0', '1.0.0', 'upgrade to 4.17.21', 'nope', ''] as const
const INSTALLED = [null, '0.5.1', '0.5.2', '1.0.0', '1.5.0', '2.0.0', '1.0.0, 1.5.0', 'garbage'] as const

type Case = { patched: string | null; recommendation: string | null; vulnerable: string; installed: string | null }

const CASES: Case[] = []
for (const vulnerable of VULNERABLE) {
    for (const patched of PATCHED) {
        for (const recommendation of RECOMMENDED) {
            for (const installed of INSTALLED) {
                CASES.push({ patched, recommendation, vulnerable, installed })
            }
        }
    }
}

function parseRange(input: string | null): Range | null {
    if (!input) return null
    const trimmed = input.trim()
    // '<0.0.0' is pnpm's "no fix available" sentinel, not a range to evaluate against.
    if (!trimmed || trimmed === '<0.0.0') return null
    try {
        return new Range(trimmed, { includePrerelease: false })
    } catch {
        return null
    }
}

function highestInstalled(installed: string | null): string | null {
    if (!installed) return null
    let highest: string | null = null
    for (const raw of installed.split(/[\s,]+/)) {
        const part = raw.trim()
        if (!part || !valid(part)) continue
        if (!highest || gte(part, highest)) highest = part
    }
    return highest
}

function describeCase(c: Case): string {
    return JSON.stringify(c)
}

describe('pickSafeFixVersion — invariants over the whole input cross-product', function () {
    it('generated the whole space', function () {
        expect(CASES).toHaveLength(VULNERABLE.length * PATCHED.length * RECOMMENDED.length * INSTALLED.length)
        expect(CASES.length).toBeGreaterThan(4000)
    })

    // THE invariant. Advice to upgrade to a version that is still vulnerable is worse than no advice at
    // all: the operator upgrades, the finding clears on the next scan, and the vulnerability is still
    // there. Everything else in this file is secondary to this line.
    it('never recommends a version that is still inside the vulnerable range', function () {
        const bad: string[] = []
        for (const c of CASES) {
            const picked = pickSafeFixVersion(c)
            if (picked === null) continue
            const vuln = parseRange(c.vulnerable)
            if (vuln && satisfies(picked, vuln)) bad.push(describeCase(c) + ' -> ' + picked)
        }
        expect(bad).toEqual([])
    })

    // A "fix" below what is already installed is a downgrade, and acting on it would REINTRODUCE whatever
    // the intervening releases fixed.
    it('never recommends a downgrade from the installed version', function () {
        const bad: string[] = []
        for (const c of CASES) {
            const picked = pickSafeFixVersion(c)
            if (picked === null) continue
            const floor = highestInstalled(c.installed)
            if (floor && !gte(picked, floor)) bad.push(describeCase(c) + ' -> ' + picked + ' below ' + floor)
        }
        expect(bad).toEqual([])
    })

    // Whatever it returns has to be an installable version. Returning a fragment of a range — which is how
    // "upgrade to ^1.0.0" or "upgrade to 4.17.x" would come out — is advice no one can act on.
    it('returns a concrete valid semver version or nothing', function () {
        const bad: string[] = []
        for (const c of CASES) {
            const picked = pickSafeFixVersion(c)
            if (picked === null) continue
            if (!valid(picked)) bad.push(describeCase(c) + ' -> ' + picked)
        }
        expect(bad).toEqual([])
    })

    // When the advisory states a patched range, the recommendation has to be inside it. Picking a version
    // that merely escapes the vulnerable range can land on one the advisory never blessed.
    it('never recommends a version outside a stated patched range', function () {
        const bad: string[] = []
        for (const c of CASES) {
            const picked = pickSafeFixVersion(c)
            if (picked === null) continue
            const patched = parseRange(c.patched)
            if (patched && !satisfies(picked, patched)) bad.push(describeCase(c) + ' -> ' + picked)
        }
        expect(bad).toEqual([])
    })

    // Determinism. The same inputs must produce the same advice on every scan, or a finding's remediation
    // text churns between runs and the operator cannot tell a real change from noise.
    it('is deterministic', function () {
        const bad: string[] = []
        for (const c of CASES) {
            if (pickSafeFixVersion(c) !== pickSafeFixVersion(c)) bad.push(describeCase(c))
        }
        expect(bad).toEqual([])
    })

    // The sweep would pass vacuously if every case returned null, which is the failure mode an invariant
    // suite is most prone to. It does not: most cases produce real advice.
    it('actually produces advice for most of the space', function () {
        const answered = CASES.filter(function hasAdvice(c) {
            return pickSafeFixVersion(c) !== null
        })
        expect(answered.length).toBeGreaterThan(CASES.length / 2)
    })
})

describe('pickSafeFixVersion — the boundary cases the feed parsers kept getting wrong', function () {
    // npm/fresh GMS-2017-232 read correctly: 0.5.2 is the fix, and it is what a user on 0.5.1 is told.
    it('names 0.5.2 as the fix for fresh <0.5.2', function () {
        expect(pickSafeFixVersion({ patched: null, recommendation: null, vulnerable: '<0.5.2', installed: '0.5.1' })).toBe('0.5.2')
    })

    // The spaced spelling of the same range must give the same answer — the defect this whole change is
    // about, checked once more at the far end of the pipeline.
    it('gives the same answer for the spaced spelling', function () {
        expect(pickSafeFixVersion({ patched: null, recommendation: null, vulnerable: '< 0.5.2', installed: '0.5.1' })).toBe('0.5.2')
    })

    // An inclusive upper bound needs the NEXT version, not the bound itself: <=0.3.3 means 0.3.3 is still
    // vulnerable, so recommending it would be advice to stay put.
    it('steps past an inclusive upper bound', function () {
        const picked = pickSafeFixVersion({ patched: null, recommendation: null, vulnerable: '<=0.3.3', installed: '0.3.0' })
        expect(picked).not.toBe('0.3.3')
        expect(picked === null || !satisfies(picked, '<=0.3.3')).toBe(true)
    })

    // npm/rc GMS-2021-3: the fix is to go DOWN to 1.2.8, and this function is forbidden from suggesting a
    // downgrade — so the honest answer is no advice rather than a version that does not exist.
    it('offers nothing rather than a wrong upgrade for the rc hijack', function () {
        const picked = pickSafeFixVersion({ patched: null, recommendation: null, vulnerable: '>1.2.8', installed: '1.2.9' })
        expect(picked === null || !satisfies(picked, '>1.2.8')).toBe(true)
    })

    // pnpm's sentinel for "there is no fix". Reading it as a real range would make every version above
    // 0.0.0 look like a fix, and 0.0.1 would be recommended as the remediation for everything.
    it('treats pnpm <0.0.0 as no fix rather than as a range', function () {
        expect(pickSafeFixVersion({ patched: null, recommendation: null, vulnerable: '<0.0.0', installed: '1.0.0' })).toBeNull()
    })

    // A multi-branch advisory: someone on 7.x must be sent to their own branch's fix, not to 8.0.1.
    it('picks the branch fix a 7.x user can actually take', function () {
        const picked = pickSafeFixVersion({
            patched: null,
            recommendation: null,
            vulnerable: '>=7.0.0 <7.6.5 || >=8.0.0 <8.0.1',
            installed: '7.5.0'
        })
        expect(picked).toBe('7.6.5')
    })
})
