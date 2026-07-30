import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_FIXTURE_ROOT, SEEDED } from './paths'

// Builds the on-disk project tree the worker discovers and scans.
//
// Generated per run rather than committed, for the reason apps/worker/src/worker-test-db.fixture.ts
// already records: a committed .gitignore would apply to this repository, and a committed .git
// directory is impossible. It is also why demo-projects/ cannot serve here — CONTRIBUTING.md notes it
// is gitignored so it does not exist in CI, and scripts/gen-demo-projects.mjs shells out to
// `npm install --package-lock-only`, which needs the network and resolves different versions over
// time. These fixtures are frozen and offline.
//
// checkout-service copies tests/fixtures/projects/npm-basic verbatim — the SAME files the CLI e2e
// suite drives (tests/e2e/cli/scan.e2e.test.ts). Sharing them means the portal and CLI suites cannot
// drift on what "the fixture project contains".

const HERE = dirname(fileURLToPath(import.meta.url))
const NPM_BASIC = resolve(HERE, '..', '..', 'fixtures', 'projects', 'npm-basic')

function write(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, 'utf8')
}

// A lockfile with exactly one dependency, written by hand rather than resolved, so it stays stable.
function soloLock(name: string, dep: string, version: string): string {
    return JSON.stringify({
        name,
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
            '': { name, version: '1.0.0', dependencies: { [dep]: version } },
            ['node_modules/' + dep]: { version }
        }
    }, null, 4) + '\n'
}

export type FixtureProject = {
    relPath: string
    // What the project is here to prove. Not used by the code — read by whoever debugs a failure.
    purpose: string
}

export const FIXTURE_PROJECTS: FixtureProject[] = [
    {
        relPath: SEEDED.projectName,
        purpose: 'two findings: lodash 4.17.11 (prod, high) and minimist 1.2.0 (dev, low)'
    },
    {
        relPath: SEEDED.cleanProjectName,
        // axios 1.7.0 against an advisory fixed in 1.6.0. A clean project is not the interesting part
        // — proving the matcher does not report a package merely for being PRESENT in an advisory is.
        purpose: 'no findings: axios 1.7.0 is already patched against GHSA-FIXTURE-axios-patched'
    },
    {
        relPath: SEEDED.unauditableProjectName,
        // yarn.lock is never parsed by the resolver, so this lands as unauditable/unsupported_lockfile
        // — giving the portal's unauditable-coverage UI a real data source rather than a fabricated row.
        purpose: 'unauditable: a yarn lockfile the resolver does not support'
    }
]

export function buildFixtureTree(): string {
    const checkout = join(E2E_FIXTURE_ROOT, SEEDED.projectName)
    mkdirSync(checkout, { recursive: true })
    copyFileSync(join(NPM_BASIC, 'package.json'), join(checkout, 'package.json'))
    copyFileSync(join(NPM_BASIC, 'package-lock.json'), join(checkout, 'package-lock.json'))
    write(join(checkout, '.nvmrc'), '24.14.0\n')
    // discovery's readGitBranch walks up for .git/HEAD, bounded by the root path. ALWAYS_SKIP covers
    // .git, so the directory is read but never walked into.
    write(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    const docs = join(E2E_FIXTURE_ROOT, SEEDED.cleanProjectName)
    write(join(docs, 'package.json'), JSON.stringify({
        name: SEEDED.cleanProjectName,
        version: '1.0.0',
        private: true,
        dependencies: { axios: '1.7.0' }
    }, null, 4) + '\n')
    write(join(docs, 'package-lock.json'), soloLock(SEEDED.cleanProjectName, 'axios', '1.7.0'))
    write(join(docs, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    const legacy = join(E2E_FIXTURE_ROOT, SEEDED.unauditableProjectName)
    write(join(legacy, 'package.json'), JSON.stringify({
        name: SEEDED.unauditableProjectName,
        version: '1.0.0',
        private: true,
        dependencies: { lodash: '4.17.11' }
    }, null, 4) + '\n')
    // Contents are irrelevant — its presence is what selects the yarn package manager and makes the
    // resolver decline. Never parsed.
    write(join(legacy, 'yarn.lock'), '# fixture: intentionally unparsed\n')

    return E2E_FIXTURE_ROOT
}
