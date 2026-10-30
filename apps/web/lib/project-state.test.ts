import { describe, expect, it } from 'vitest'
import type { ScanState } from '@sentinello/core'
import type { ProjectCatalogRow } from '@sentinello/db'
import { isProjectHealthy, languageNames, projectsWithoutSource, scanStateBadge, scanStateReasonsText, sourceDisabledEcosystems } from './project-state'

function row(scanState: ScanState): ProjectCatalogRow {
    return { scanState } as ProjectCatalogRow
}

const SCANNED: ScanState = { state: 'scanned', reasons: [] }
const CANNOT: ScanState = {
    state: 'cannot_scan',
    reasons: [
        { source: 'npm-audit', ecosystem: null, reasonCode: 'no_lockfile', side: 'project' },
        { source: null, ecosystem: 'npm', reasonCode: 'no_lockfile', side: 'project' }
    ]
}
const PARTIAL: ScanState = {
    state: 'partial',
    reasons: [
        { source: 'osv', ecosystem: null, reasonCode: 'osv_db_not_seeded', side: 'environment' },
        { source: null, ecosystem: 'npm', reasonCode: 'not_yet_run', side: null }
    ]
}
// A Python and Ruby project on an install with OSV and gemnasium off: nothing is expected to scan it.
const NO_SOURCE: ScanState = {
    state: 'cannot_scan',
    reasons: [
        { source: null, ecosystem: 'PyPI', reasonCode: 'ecosystem_source_disabled', side: 'environment' },
        { source: null, ecosystem: 'RubyGems', reasonCode: 'ecosystem_source_disabled', side: 'environment' }
    ]
}
// An npm and Python project: npm audit answered for npm, nothing is enabled for Python.
const NPM_AND_NO_PYTHON: ScanState = {
    state: 'partial',
    reasons: [{ source: null, ecosystem: 'PyPI', reasonCode: 'ecosystem_source_disabled', side: 'environment' }]
}
const SIDES = { project: 'the project', environment: 'this install' }

function sourceDisabled(languages: string): string {
    return 'No source enabled for ' + languages
}

describe('isProjectHealthy', function () {
    it('is healthy only when the project was fully scanned and nothing was found', function () {
        expect(isProjectHealthy(row(SCANNED), 0)).toBe(true)
        expect(isProjectHealthy(row(SCANNED), 3)).toBe(false)
    })

    // Zero findings because nothing could look is not clean: a project that cannot be scanned is never
    // hidden as healthy.
    it('is not healthy when the project cannot be scanned, cannot be fully scanned, or was never scanned', function () {
        expect(isProjectHealthy(row(CANNOT), 0)).toBe(false)
        expect(isProjectHealthy(row(PARTIAL), 0)).toBe(false)
        expect(isProjectHealthy(row({ state: 'not_scanned_yet', reasons: [] }), 0)).toBe(false)
    })
})

describe('the State column — cannot be scanned', function () {
    it('names each state but a fully scanned one', function () {
        expect(scanStateBadge(CANNOT)).toBe('cannotScan')
        expect(scanStateBadge(PARTIAL)).toBe('partial')
        expect(scanStateBadge({ state: 'not_scanned_yet', reasons: [] })).toBe('notScannedYet')
        expect(scanStateBadge(SCANNED)).toBeNull()
    })

    it('lists the reasons once each, with whose side they are on, in the reader locale', function () {
        expect(scanStateReasonsText(CANNOT, 'en', SIDES, sourceDisabled)).toBe('No lockfile (the project)')
        expect(scanStateReasonsText(PARTIAL, 'en', SIDES, sourceDisabled)).toBe('OSV database not downloaded yet (this install) · npm: Has not run yet')
        expect(scanStateReasonsText(CANNOT, 'es', { project: 'el proyecto', environment: 'esta instalación' }, sourceDisabled)).toBe('Sin lockfile (el proyecto)')
    })

    // "No source enabled for ecosystem" would leave the reader guessing which one: the language is named,
    // once for every language the project has no source for.
    it('names the languages no enabled source answers for', function () {
        expect(scanStateReasonsText(NO_SOURCE, 'en', SIDES, sourceDisabled)).toBe('No source enabled for Python, Ruby (this install)')
        expect(scanStateReasonsText(NPM_AND_NO_PYTHON, 'en', SIDES, sourceDisabled)).toBe('No source enabled for Python (this install)')
    })

    // A project with no enabled source is never healthy: it is unknown, not clean.
    it('never reads a project no source answers for as healthy', function () {
        expect(isProjectHealthy(row(NO_SOURCE), 0)).toBe(false)
        expect(scanStateBadge(NO_SOURCE)).toBe('cannotScan')
        expect(scanStateBadge(NPM_AND_NO_PYTHON)).toBe('partial')
    })
})

describe('languageNames', function () {
    it('names ecosystems by language, and keeps an id the registry does not know', function () {
        expect(languageNames(['PyPI', 'Go', 'crates.io', 'RubyGems', 'npm'])).toBe('Python, Go, Rust, Ruby, Node.js')
        expect(languageNames(['CocoaPods'])).toBe('CocoaPods')
        expect(languageNames([])).toBe('')
    })
})

describe('projects with no enabled source', function () {
    it('lists the ecosystems a project has no enabled source for', function () {
        expect(sourceDisabledEcosystems(NO_SOURCE)).toEqual(['PyPI', 'RubyGems'])
        expect(sourceDisabledEcosystems(PARTIAL)).toEqual([])
        expect(sourceDisabledEcosystems(SCANNED)).toEqual([])
    })

    // The count is of projects, each once however many languages it lacks a source for; the per-language
    // counts are in registry order, whatever order the projects came in.
    it('counts the projects and, per language, how many it leaves unscanned', function () {
        expect(projectsWithoutSource([SCANNED, NPM_AND_NO_PYTHON, CANNOT, NO_SOURCE, PARTIAL])).toEqual({
            projects: 2,
            ecosystems: [
                { ecosystem: 'PyPI', projects: 2 },
                { ecosystem: 'RubyGems', projects: 1 }
            ]
        })
    })

    it('counts nothing on an install where every project has a source', function () {
        expect(projectsWithoutSource([SCANNED, CANNOT, PARTIAL])).toEqual({ projects: 0, ecosystems: [] })
        expect(projectsWithoutSource([])).toEqual({ projects: 0, ecosystems: [] })
    })
})
