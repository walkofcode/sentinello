import { rowsFor, runSmoke, type Collected } from './smoke-common'

// Milestone 2's smoke: only released fixes. Exits non-zero on any failed assertion.
//
//   --fixture                       the fixture project against the deterministic stub registry (see
//                                   smoke-common.ts for the steps), with this script's historical set.
//   --scratch <db> --project <id>   a real project on a scratch COPY of the live database, against the
//                                   live registry, invariants only. [--out <file>] [--cold]

// The exact outcomes recorded from the 2026-10-03 registry. Run only against the stub, which never moves.
function historicalFailures(input: Collected): string[] {
    const failures: string[] = []
    for (const [pkg, advisory] of [['braces', 'GHSA-vfj7-8cjw-p6xm'], ['node-forge', 'GHSA-86w9-cpqp-85rv']] as const) {
        const rows = rowsFor(input, pkg, advisory)
        if (rows.length === 0) failures.push('historical: no ' + pkg + ' ' + advisory + ' row')
        for (const r of rows) {
            if (r.fixStatus !== 'none_released' || r.fixVersion !== null || r.severity !== 'high') {
                failures.push('historical: ' + pkg + ' is ' + r.fixStatus + ' ' + r.fixVersion + ' at ' + r.severity + ', expected none_released null at high')
            }
        }
    }
    const qs = rowsFor(input, 'qs')
    if (qs.length === 0 || !qs.every(function six(r) { return r.fixStatus === 'released' && r.fixVersion === '6.16.0' })) {
        failures.push('historical: qs >=6.14.2 <=6.15.3 is ' + qs.map(function s(r) { return r.fixStatus + ' ' + r.fixVersion }).join(', ') + ', expected released 6.16.0')
    }
    const braces = input.exportMarkdown.split('\n### ').find(function entry(e) { return e.includes('`braces@') }) ?? ''
    if (!braces.includes('- **Fix:** **No fixed version released**')) failures.push('historical: the export Fix line for braces does not say "No fixed version released"')
    return failures
}

// nodemon-escape changes only a chain verdict, none of the fix outcomes pinned above.
runSmoke({ name: 'smoke-fix-status', historical: historicalFailures, nodemonEscapeChangesHistory: false })
