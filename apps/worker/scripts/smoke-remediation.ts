import type { Remediation } from '@sentinello/core'
import { rowsFor, runSmoke, type Collected } from './smoke-common'

// Milestone 3's smoke: the way out. Exits non-zero on any failed assertion.
//
//   --fixture                       the fixture project against the deterministic stub registry (see
//                                   smoke-common.ts for the steps), with this script's historical set.
//   --scratch <db> --project <id>   a real project on a scratch COPY of the live database, against the
//                                   live registry, invariants only (the way-out invariants included).
//                                   [--out <file>] [--cold]

const BRACES = 'GHSA-vfj7-8cjw-p6xm'
const FORGE = 'GHSA-86w9-cpqp-85rv'

// The exact way out recorded from the 2026-10-03 registry. Run only against the stub, which never moves.
function historicalFailures(input: Collected): string[] {
    const failures: string[] = []
    const braces = rowsFor(input, 'braces', BRACES)
    if (braces.length === 0) failures.push('historical: no braces ' + BRACES + ' row')
    for (const row of braces) {
        if (row.remediationJson === null) {
            failures.push('historical: braces has no way-out (' + row.fixStatus + ')')
            continue
        }
        const r = JSON.parse(row.remediationJson) as Remediation
        const h = r.health
        if (h.lastPublishAt !== Date.parse('2024-05-21T08:59:11.390Z')) failures.push('historical: braces last publish is ' + h.lastPublishAt + ', expected 2024-05-21T08:59:11.390Z')
        if (!h.unmaintained || h.maintainers !== 2 || h.weeklyDownloads !== 204706783) failures.push('historical: braces health is ' + JSON.stringify(h) + ', expected unmaintained, 2 maintainers, 204,706,783 weekly downloads')
        const nodemon = r.chains.find(function n(c) { return c.path[0] === 'nodemon@3.1.14' })
        const expectedBlocked = { kind: 'blocked', escapePackage: 'chokidar', escapeVersion: '4.0.0', blockedBy: 'nodemon', blockedByLatest: '3.1.14', blockedRange: '^3.5.2' }
        if (!nodemon || nodemon.rootKind !== 'dev' || JSON.stringify({ ...nodemon.verdict, proof: undefined }) !== JSON.stringify({ ...expectedBlocked, proof: undefined })) {
            failures.push('historical: the nodemon chain is ' + JSON.stringify(nodemon?.verdict) + ', expected chokidar ≥ 4.0.0 blocked by nodemon 3.1.14 (^3.5.2)')
        }
        const fastGlob = r.chains.find(function f(c) { return c.path[0] === '@next/eslint-plugin-next@16.3.8' })
        const noEscape = fastGlob?.verdict.kind === 'noEscape' ? fastGlob.verdict.packages : null
        if (JSON.stringify(noEscape) !== JSON.stringify(['micromatch', 'fast-glob', '@next/eslint-plugin-next'])) failures.push('historical: the fast-glob chain is ' + JSON.stringify(fastGlob?.verdict) + ', expected noEscape past micromatch up to @next/eslint-plugin-next')
        const tinyglobby = r.alternatives.find(function a(x) { return x.replaces === 'fast-glob' })?.options.find(function o(x) { return x.kind === 'module' && x.name === 'tinyglobby' })
        if (!tinyglobby || tinyglobby.kind !== 'module' || !tinyglobby.verified || tinyglobby.proof === null) failures.push('historical: tinyglobby is not offered for fast-glob with its closure proof: ' + JSON.stringify(tinyglobby))
        if (r.devOnly !== true) failures.push('historical: braces is reached only by dev tooling, but devOnly is ' + String(r.devOnly))
        // There is no lookup cap: an unknown verdict names a real cause, never a budget.
        const budgeted = r.chains.filter(function b(c) { return c.verdict.kind === 'unknown' && /budget/i.test(c.verdict.reason) })
        if (budgeted.length > 0) failures.push('historical: a fixture way-out verdict names a budget: ' + JSON.stringify(budgeted.map(function v(c) { return c.verdict })))
    }
    for (const row of rowsFor(input, 'node-forge', FORGE)) {
        const r = row.remediationJson === null ? null : JSON.parse(row.remediationJson) as Remediation
        if (!r || !r.health.unmaintained || r.chains[0]?.verdict.kind !== 'direct' || r.devOnly !== false) failures.push('historical: node-forge should be a direct, unmaintained production dependency: ' + JSON.stringify(r && { health: r.health.unmaintained, chains: r.chains.map(function k(c) { return c.verdict.kind }), devOnly: r.devOnly }))
    }
    const entry = input.exportMarkdown.split('\n### ').find(function b(e) { return e.includes('`braces@') }) ?? ''
    if (!entry.includes('- **Way out:**') || !entry.includes('[dev tooling only]')) failures.push('historical: the export entry for braces has no way-out block with its dev tooling tag')
    return failures
}

// nodemon-escape turns the nodemon chain from blocked into an upgrade, which this set pins.
runSmoke({ name: 'smoke-remediation', historical: historicalFailures, nodemonEscapeChangesHistory: true })
