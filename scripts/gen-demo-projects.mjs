// Generates demo-projects/ — a throwaway, gitignored set of sample projects used to exercise the
// full Sentinello pipeline (Docker -> nvm install -> npm audit) end to end without needing real
// repos. Run once with `pnpm demo:gen`, then `pnpm demo:up` to build + run the image against them.
//
// Each project pins a different REAL, published Node major in its .nvmrc (the Node version belongs
// in .nvmrc, not .npmrc) so `nvm install` succeeds, and pins dependencies to old versions with
// known advisories so `npm audit` reports real findings.
//
// One project also carries an `osvOnly` dep — a known-malicious package npm audit can't see (it's
// unpublished, so the registry advisory API returns nothing for it). It's spliced into the lockfile
// AFTER npm resolves the real deps, so enabling the OSV source surfaces a finding (a critical MAL-
// "malicious" advisory) that the default npm-audit source never produces. That's the whole point: it
// gives you a way to verify OSV is actually doing something the built-in source can't.

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEMO_DIR = join(ROOT, 'demo-projects')

// Realistic-looking project names (good for screenshots). The Node version per project still spans
// 22-26 (shown in the UI from each .nvmrc); edit this list to change the spread or the dep mix.
const PROJECTS = [
    { name: 'payments-api', node: '22.22.3', deps: { lodash: '4.17.11', minimist: '1.2.0' } },
    { name: 'customer-portal', node: '23.11.1', deps: { axios: '0.21.1', 'node-fetch': '2.6.0' } },
    { name: 'analytics-worker', node: '24.15.0', deps: { handlebars: '4.0.11' } },
    { name: 'content-cms', node: '25.9.0', deps: { marked: '0.3.6', y18n: '4.0.0' } },
    // discord.dll is a real typosquat-style malware package (OSV: MAL-2025-18479, "Malicious code in
    // discord.dll"). npm audit doesn't carry MAL- records, so only the OSV source flags it — as critical.
    { name: 'admin-dashboard', node: '26.2.0', deps: { express: '4.16.0', jsonwebtoken: '8.5.0' }, osvOnly: { 'discord.dll': '1.0.0' } }
]

async function generateProject(project) {
    const dir = join(DEMO_DIR, project.name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.nvmrc'), project.node + '\n', 'utf8')
    const pkg = {
        name: project.name,
        version: '1.0.0',
        private: true,
        description: 'Sentinello demo project (Node ' + project.node + ') — intentionally vulnerable deps',
        dependencies: project.deps
    }
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 4) + '\n', 'utf8')
    console.log('[demo] ' + project.name + ': resolving package-lock.json (Node ' + project.node + ')')
    await execFileAsync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: dir })
    if (project.osvOnly) {
        await injectOsvOnlyDeps(dir, project.osvOnly)
        console.log('[demo] ' + project.name + ': injected OSV-only deps (' + Object.keys(project.osvOnly).join(', ') + ')')
    }
    console.log('[demo] ' + project.name + ': done')
}

// Splices unpublished, OSV-only packages straight into the resolved lockfile and manifest AFTER npm
// has written them — npm can't resolve a package the registry no longer serves, but the OSV scanner
// matches the lockfile by name@version (it never touches node_modules or the network for the match),
// so a fabricated entry is enough. integrity/resolved are placeholders: npm audit and OSV both key off
// name@version, not the tarball hash, and nothing here ever installs the package.
async function injectOsvOnlyDeps(dir, osvOnly) {
    const pkgPath = join(dir, 'package.json')
    const lockPath = join(dir, 'package-lock.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    const root = lock.packages[''] ?? (lock.packages[''] = {})
    root.dependencies = root.dependencies ?? {}
    for (const [name, version] of Object.entries(osvOnly)) {
        pkg.dependencies[name] = version
        root.dependencies[name] = version
        lock.packages['node_modules/' + name] = {
            version,
            resolved: 'https://registry.npmjs.org/' + name + '/-/' + name + '-' + version + '.tgz',
            integrity: 'sha512-' + 'A'.repeat(86) + '=='
        }
    }
    await writeFile(pkgPath, JSON.stringify(pkg, null, 4) + '\n', 'utf8')
    await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8')
}

async function main() {
    await rm(DEMO_DIR, { recursive: true, force: true })
    await mkdir(DEMO_DIR, { recursive: true })
    for (const project of PROJECTS) {
        await generateProject(project)
    }
    console.log('[demo] generated ' + PROJECTS.length + ' projects in ' + DEMO_DIR)
    console.log('[demo] next: pnpm demo:up  (builds the image and scans demo-projects at /roots/demo)')
}

main().catch(function onError(err) {
    console.error('[demo] failed: ' + (err && err.message || String(err)))
    process.exit(1)
})
