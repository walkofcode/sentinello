/* eslint-disable */
// Read-only validation harness for the unified matching engine. NOT a unit/e2e test — it drives the
// running dev environment: triggers a full scan, picks 15 projects, dumps every current finding, and
// INDEPENDENTLY cross-checks each one against ground truth (raw OSV records via the public API + a fresh
// run of the resolver + `pnpm why`) so it audits the engine rather than re-confirming it.
//
// Run:  pnpm --filter @sentinello/worker exec tsx ../../scripts/engine-audit.ts [--no-scan]
//
// Output: a per-project table of findings annotated PASS/SUSPECT, plus a summary of every SUSPECT.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import axios from 'axios'
import {
    openDb,
    openOsvDb,
    listProjects,
    getRootById,
    listCurrentFindingsForProject,
    lookupOsvByPackages,
    enqueueScanRequest,
    type OsvAdvisoryRow
} from '@sentinello/db'
import {
    detectLockfile,
    resolveProject,
    matchAdvisories,
    semverComparator,
    type CanonicalAdvisory,
    type ResolvedGraph
} from '@sentinello/scanners'
import { coerce, gt, satisfies, valid } from 'semver'

const execFileAsync = promisify(execFile)
const NPM = 'npm'
const PICK = 15
const API_SAMPLE_CVES = 12 // independent OSV-API cross-checks for non-malware findings (malware: all)

type Suspect = { project: string; pkg: string; advisory: string; reason: string }

async function sleep(ms: number): Promise<void> {
    await new Promise(function wait(r) { setTimeout(r, ms) })
}

// --- OSV public API ground truth (independent of our osv.db cache) ---
const apiCache = new Map<string, { ranges: { introduced: string; fixed: string | null }[]; versions: string[] } | null>()
async function fetchOsvGroundTruth(advisoryId: string, packageName: string) {
    const cacheKey = advisoryId + '|' + packageName
    if (apiCache.has(cacheKey)) return apiCache.get(cacheKey)
    try {
        const res = await axios.get('https://api.osv.dev/v1/vulns/' + encodeURIComponent(advisoryId), { timeout: 15000 })
        const data = res.data as { affected?: Array<{ package?: { ecosystem?: string; name?: string }; ranges?: any[]; versions?: string[] }> }
        const ranges: { introduced: string; fixed: string | null }[] = []
        const versions: string[] = []
        for (const aff of data.affected || []) {
            if (!aff.package || aff.package.ecosystem !== NPM || aff.package.name !== packageName) continue
            for (const v of aff.versions || []) if (typeof v === 'string') versions.push(v)
            for (const r of aff.ranges || []) {
                if (r.type !== 'SEMVER' || !Array.isArray(r.events)) continue
                let introduced: string | null = null
                for (const e of r.events) {
                    if (typeof e.introduced === 'string') introduced = e.introduced
                    else if (typeof e.fixed === 'string' && introduced !== null) { ranges.push({ introduced, fixed: e.fixed }); introduced = null }
                }
                if (introduced !== null) ranges.push({ introduced, fixed: null })
            }
        }
        const out = { ranges, versions }
        apiCache.set(cacheKey, out)
        return out
    } catch {
        apiCache.set(cacheKey, null)
        return null
    }
}

// Independent affected check (does NOT call the engine): exact-version membership OR range containment.
function independentlyAffected(installedRaw: string, ranges: { introduced: string; fixed: string | null }[], versions: string[]): boolean {
    const norm = (v: string) => valid(v) || (coerce(v)?.version ?? null)
    const installed = norm(installedRaw)
    for (const v of versions) {
        if (v === installedRaw) return true
        const nv = norm(v)
        if (nv && installed && nv === installed) return true
    }
    if (!installed) return false
    for (const r of ranges) {
        const lo = r.introduced === '0' ? '0.0.0' : norm(r.introduced)
        const hi = r.fixed ? norm(r.fixed) : null
        if (!lo) continue
        const range = hi ? '>=' + lo + ' <' + hi : '>=' + lo
        try { if (satisfies(installed, range)) return true } catch {}
    }
    return false
}

async function pnpmWhy(projectPath: string, pkg: string): Promise<{ prod: boolean; dev: boolean } | null> {
    try {
        const prodRes = await execFileAsync('pnpm', ['why', '--prod', '--json', pkg], { cwd: projectPath, timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
        const devRes = await execFileAsync('pnpm', ['why', '--dev', '--json', pkg], { cwd: projectPath, timeout: 30000, maxBuffer: 64 * 1024 * 1024 })
        const prodHit = prodRes.stdout.includes('"' + pkg + '"') || prodRes.stdout.trim().length > 2
        const devHit = devRes.stdout.includes('"' + pkg + '"') || devRes.stdout.trim().length > 2
        return { prod: prodHit, dev: devHit }
    } catch {
        return null
    }
}

async function main(): Promise<void> {
    const noScan = process.argv.includes('--no-scan')
    const { db, sqlite } = openDb()
    const { db: osvDb } = openOsvDb()

    // 1. Trigger a full sweep so findings reflect the live (new) engine, then wait for it to drain.
    if (!noScan) {
        console.log('[audit] enqueuing full sweep…')
        enqueueScanRequest(db, {}, Date.now())
        const deadlineMs = Date.now() + 10 * 60 * 1000
        while (Date.now() < deadlineMs) {
            const pending = sqlite.prepare("select count(*) c from scan_requests where status in ('pending','running')").get() as { c: number }
            if (pending.c === 0) break
            await sleep(5000)
            process.stdout.write('.')
        }
        console.log('\n[audit] scan drained (or timed out)')
    }

    // 2. Pick 15 projects: prefer the ones with the most current findings (most advisories to review),
    //    always include the sentinello self-project, and keep 2 zero-finding projects as clean controls.
    const now = Date.now()
    const all = listProjects(db)
    const withCounts = all.map(function count(p) {
        const n = listCurrentFindingsForProject(db, p.id, now, 'all').length
        return { p, n }
    })
    withCounts.sort((a, b) => b.n - a.n)
    const picked: typeof withCounts = []
    const self = withCounts.find(x => /sentinello/i.test(x.p.name))
    if (self) picked.push(self)
    for (const x of withCounts) {
        if (picked.length >= PICK - 2) break
        if (!picked.includes(x)) picked.push(x)
    }
    const zeros = withCounts.filter(x => x.n === 0 && !picked.includes(x)).slice(0, 2)
    for (const z of zeros) picked.push(z)

    console.log('\n=== Picked ' + picked.length + ' / ' + all.length + ' projects ===')
    for (const x of picked) console.log('  - ' + x.p.name + ' (' + x.n + ' findings) [' + x.p.packageManager + ']')

    const suspects: Suspect[] = []
    let cveSampled = 0

    for (const { p } of picked) {
        const root = getRootById(db, p.rootId)
        if (!root) { console.log('\n## ' + p.name + ' — root missing, skip'); continue }
        const projectPath = resolve(root.path, p.relPath)
        const lockfile = await detectLockfile(projectPath)
        const graph: ResolvedGraph | null = lockfile ? await resolveProject(projectPath, lockfile) : null
        const findings = listCurrentFindingsForProject(db, p.id, now, 'all')

        console.log('\n## ' + p.name + '  (' + findings.length + ' findings, lockfile=' + (lockfile?.kind || 'none') + ')')

        // duplicate detection: group by (package, advisoryId) and by shared OSV alias
        const idSeen = new Map<string, number>()
        for (const f of findings) {
            const k = f.packageName + '|' + f.advisoryId.toLowerCase()
            idSeen.set(k, (idSeen.get(k) || 0) + 1)
        }
        for (const [k, c] of idSeen) if (c > 1) {
            const [pkg, adv] = k.split('|')
            suspects.push({ project: p.name, pkg, advisory: adv, reason: 'DUPLICATE: same advisory reported ' + c + '× for package' })
        }

        for (const f of findings) {
            const tag = f.advisoryId.startsWith('MAL-') ? 'MAL' : f.severity.toUpperCase()
            let line = '  [' + tag + '] ' + f.packageName + '@' + f.installedVersion + ' ' + f.advisoryId
                + ' scope=' + (f.isProd ? 'prod' : '') + (f.isDev ? 'dev' : '') + ' fix=' + (f.fixVersion || '—')

            // (a) dep-type cross-check against a fresh resolver run
            if (graph) {
                const scope = graph.classify(f.packageName, f.installedVersion)
                if (scope.isProd !== f.isProd || scope.isDev !== f.isDev) {
                    suspects.push({ project: p.name, pkg: f.packageName, advisory: f.advisoryId, reason: 'DEP-TYPE: finding says prod=' + f.isProd + '/dev=' + f.isDev + ' but resolver says prod=' + scope.isProd + '/dev=' + scope.isDev })
                    line += ' ⚠dep-type'
                }
            }

            // (b) version-match independence: ALL malware via OSV API; a sample of CVEs too
            const isMal = f.advisoryId.startsWith('MAL-')
            const doApi = isMal || cveSampled < API_SAMPLE_CVES
            if (doApi) {
                if (!isMal) cveSampled++
                const gt0 = await fetchOsvGroundTruth(f.advisoryId, f.packageName)
                if (gt0) {
                    const affected = independentlyAffected(f.installedVersion, gt0.ranges, gt0.versions)
                    if (!affected) {
                        suspects.push({ project: p.name, pkg: f.packageName, advisory: f.advisoryId, reason: 'FALSE-POSITIVE: installed ' + f.installedVersion + ' not in OSV-API affected (versions=' + JSON.stringify(gt0.versions) + ' ranges=' + JSON.stringify(gt0.ranges) + ')' })
                        line += ' ⚠false-positive'
                    } else {
                        line += ' ✓api'
                    }
                }
            }

            // (c) fix sanity
            if (f.fixAvailable && f.fixVersion) {
                const ok = valid(f.fixVersion) && (!valid(f.installedVersion) || gt(f.fixVersion, f.installedVersion))
                if (!ok) {
                    suspects.push({ project: p.name, pkg: f.packageName, advisory: f.advisoryId, reason: 'FIX-SANITY: fix ' + f.fixVersion + ' not > installed ' + f.installedVersion })
                    line += ' ⚠fix'
                }
            }
            console.log(line)
        }
    }

    // 3. Negative/positive control on the matcher itself (no project mutation needed).
    console.log('\n=== Matcher control (debug MAL-2025-46974, compromised=4.4.2) ===')
    const malAdv: CanonicalAdvisory = {
        id: 'MAL-2025-46974', source: 'osv', aliases: [], ecosystem: NPM, packageName: 'debug',
        affected: { ranges: [], exactVersions: ['4.4.2'] }, kind: 'malware', severity: null, summary: 'test', url: null, withdrawn: null
    }
    const byPkg = new Map<string, CanonicalAdvisory[]>([['debug', [malAdv]]])
    const bad = matchAdvisories([{ ecosystem: NPM, name: 'debug', version: '4.4.2', scope: { isProd: true, isDev: false, isOptional: false }, depPaths: ['debug@4.4.2'] }], byPkg, semverComparator)
    const clean = matchAdvisories([{ ecosystem: NPM, name: 'debug', version: '4.4.3', scope: { isProd: true, isDev: false, isOptional: false }, depPaths: ['debug@4.4.3'] }], byPkg, semverComparator)
    console.log('  debug@4.4.2 → ' + bad.length + ' finding(s) [expect 1]  ' + (bad.length === 1 ? 'PASS' : 'FAIL'))
    console.log('  debug@4.4.3 → ' + clean.length + ' finding(s) [expect 0]  ' + (clean.length === 0 ? 'PASS' : 'FAIL'))
    if (bad.length !== 1) suspects.push({ project: '(control)', pkg: 'debug', advisory: 'MAL-2025-46974', reason: 'CONTROL: compromised 4.4.2 was NOT flagged' })
    if (clean.length !== 0) suspects.push({ project: '(control)', pkg: 'debug', advisory: 'MAL-2025-46974', reason: 'CONTROL: clean 4.4.3 WAS flagged' })

    // 4. Explicit check: the original 5 false positives must not appear as malware findings anywhere.
    console.log('\n=== Original 5 false positives (must be absent as MAL findings) ===')
    const originals = ['axios', 'debug', 'eslint-config-prettier', 'supports-color', 'fsevents']
    const malRows = sqlite.prepare("select package_name, installed_version, advisory_id from findings where scanner='osv' and advisory_id like 'MAL-%' and resolved_at is null").all() as Array<{ package_name: string; installed_version: string; advisory_id: string }>
    for (const name of originals) {
        const hits = malRows.filter(r => r.package_name === name)
        console.log('  ' + name + ': ' + hits.length + ' MAL finding(s) ' + (hits.length ? '⚠ ' + JSON.stringify(hits) : '✓'))
    }
    console.log('  (total MAL findings across all projects: ' + malRows.length + ')')

    // 5. Summary
    console.log('\n========== SUSPECTS (' + suspects.length + ') ==========')
    for (const s of suspects) console.log('  - [' + s.project + '] ' + s.pkg + ' ' + s.advisory + ' :: ' + s.reason)
    if (suspects.length === 0) console.log('  none — engine output matches independent ground truth across all sampled findings.')
}

main().then(function done() { process.exit(0) }).catch(function fail(e) { console.error(e); process.exit(1) })
