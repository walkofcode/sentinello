// Read `pnpm licenses list --prod --json` from stdin, emit THIRD_PARTY_LICENSES.md to stdout.
// Run: pnpm licenses list --prod --json | node scripts/render-third-party-licenses.mjs > THIRD_PARTY_LICENSES.md

import { readFileSync } from 'node:fs'

const raw = readFileSync(0, 'utf8')
const d = JSON.parse(raw)
const total = Object.values(d).reduce(function (a, v) { return a + v.length }, 0)
const licenses = Object.keys(d).sort()

const lines = []
lines.push('# Third-Party Licenses')
lines.push('')
lines.push('Sentinello bundles the following production dependencies. This file is generated —')
lines.push('do not hand-edit. Regenerate with:')
lines.push('')
lines.push('```')
lines.push('pnpm licenses list --prod --json | node scripts/render-third-party-licenses.mjs > THIRD_PARTY_LICENSES.md')
lines.push('```')
lines.push('')
lines.push('Counts: ' + total + ' packages across ' + licenses.length + ' license identifiers.')
lines.push('')
for (const lic of licenses) {
    const pkgs = d[lic].slice().sort(function (a, b) { return a.name.localeCompare(b.name) })
    lines.push('## ' + lic + ' (' + pkgs.length + ')')
    lines.push('')
    for (const p of pkgs) {
        lines.push('- `' + p.name + '` ' + p.versions.join(', '))
    }
    lines.push('')
}
process.stdout.write(lines.join('\n'))
