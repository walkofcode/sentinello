import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revalidatePath } from 'next/cache'
import { insertMute, listActiveMutes } from '@sentinello/db'
import type { Mute } from '@sentinello/core'
import { closePortalTestDb, openPortalTestDb, seedProject, seedRoot, T0, type PortalTestDb } from '@/lib/portal-test-db.fixture'
import {
    muteAction,
    muteLibraryAction,
    muteLibraryEverywhereAction,
    unmuteAction,
    unmuteManyAction
} from './mute'

vi.mock('next/cache', function stubNextCache() {
    return { revalidatePath: vi.fn() }
})

let handle: PortalTestDb

function bustedPaths(): string[] {
    return vi.mocked(revalidatePath).mock.calls.map(function first(call) { return call[0] })
}

function activeMutes(): Mute[] {
    return listActiveMutes(handle.db, T0)
}

// Asserting on the mute that was just created, without every caller narrowing the index. When no mute
// exists the failure is that the action created none — say so, rather than reporting a TypeError on
// undefined from whichever property the test happened to read.
function firstMute(): Mute {
    const [mute] = activeMutes()
    if (!mute) throw new Error('expected the action to have created a mute, but none is active')
    return mute
}

function seedMute(id: string, overrides: Partial<Mute> = {}): void {
    insertMute(handle.db, {
        id,
        scope: 'finding',
        projectId: 'project-1',
        scanner: 'npm-audit',
        ecosystem: 'npm',
        advisoryId: 'CVE-2024-1',
        packageName: 'lodash',
        reason: 'accepted risk',
        author: 'betty',
        createdAt: T0,
        expiresAt: null,
        ...overrides
    } as Mute)
}

beforeEach(async function setup() {
    vi.mocked(revalidatePath).mockClear()
    handle = await openPortalTestDb('mute-action')
    seedRoot(handle.db)
    seedProject(handle.db, 'project-1')
    seedProject(handle.db, 'project-2')
})

afterEach(async function teardown() {
    delete process.env.ME_NAME
    await closePortalTestDb(handle)
})

// A mute records a human's accepted-risk decision, so the two failure modes are asymmetric: muting
// too much silently hides real vulnerabilities, while muting too little only annoys. Every test
// below is about which findings a given submission does and does not silence.
describe('muteAction', function () {
    const findingInput = {
        scope: 'finding' as const,
        projectId: 'project-1',
        source: 'npm-audit',
        advisoryId: 'CVE-2024-1',
        packageName: 'lodash',
        reason: 'accepted risk',
        expiresAt: null
    }

    it('creates a finding-scope mute with the submitted identity', async function () {
        await muteAction(findingInput)

        expect(activeMutes()).toHaveLength(1)
        expect(activeMutes()[0]).toMatchObject({
            scope: 'finding',
            projectId: 'project-1',
            scanner: 'npm-audit',
            ecosystem: 'npm',
            advisoryId: 'CVE-2024-1',
            packageName: 'lodash',
            reason: 'accepted risk'
        })
    })

    // A finding-scope mute is keyed on (source, ecosystem, advisoryId, packageName). Missing any
    // part of that key would produce a mute that matches far more than the operator selected.
    it.each([
        ['source', { source: null }],
        ['advisoryId', { advisoryId: null }],
        ['packageName', { packageName: null }]
    ])('rejects a finding-scope mute missing %s', async function (_label, patch) {
        await expect(muteAction({ ...findingInput, ...patch })).rejects.toThrow(
            'finding-scope mutes require source, advisoryId, and packageName'
        )
        expect(activeMutes()).toEqual([])
    })

    // The reason is the audit trail — a mute without one is an unexplained silence.
    it('rejects an empty or whitespace-only reason', async function () {
        await expect(muteAction({ ...findingInput, reason: '   ' })).rejects.toThrow('mute reason is required')
        expect(activeMutes()).toEqual([])
    })

    it('trims the stored reason', async function () {
        await muteAction({ ...findingInput, reason: '  accepted risk  ' })

        expect(firstMute().reason).toBe('accepted risk')
    })

    // A project-scope mute silences the whole project, so carrying an advisory identity would be
    // misleading — the identity columns are deliberately nulled out regardless of what was posted.
    it('nulls every finding identity column on a project-scope mute', async function () {
        await muteAction({ ...findingInput, scope: 'project' })

        expect(activeMutes()[0]).toMatchObject({
            scope: 'project',
            projectId: 'project-1',
            scanner: null,
            ecosystem: null,
            advisoryId: null,
            packageName: null
        })
    })

    it('skips the identity validation for a project-scope mute', async function () {
        await expect(
            muteAction({ ...findingInput, scope: 'project', source: null, advisoryId: null, packageName: null })
        ).resolves.toBeUndefined()

        expect(activeMutes()).toHaveLength(1)
    })

    // Ecosystem-aware callers pass the real value; older ones have none. Defaulting to npm keeps a
    // mute from being ecosystem-wildcard, which would silence a same-named PyPI package too.
    it('defaults a missing ecosystem to npm', async function () {
        await muteAction(findingInput)

        expect(firstMute().ecosystem).toBe('npm')
    })

    it('honours an explicit ecosystem', async function () {
        await muteAction({ ...findingInput, ecosystem: 'PyPI' })

        expect(firstMute().ecosystem).toBe('PyPI')
    })

    it('records the operator from ME_NAME', async function () {
        process.env.ME_NAME = 'betty'

        await muteAction(findingInput)

        expect(firstMute().author).toBe('betty')
    })

    it('falls back to anonymous when ME_NAME is unset', async function () {
        delete process.env.ME_NAME

        await muteAction(findingInput)

        expect(firstMute().author).toBe('anonymous')
    })

    it('stores an expiry when one is given', async function () {
        await muteAction({ ...findingInput, expiresAt: T0 + 86_400_000 })

        expect(firstMute().expiresAt).toBe(T0 + 86_400_000)
    })

    it('busts the project page, the projects list and the dashboard', async function () {
        await muteAction(findingInput)

        expect(bustedPaths()).toEqual(['/projects/project-1', '/projects', '/'])
    })

    it('skips the project page when the mute has no project', async function () {
        await muteAction({ ...findingInput, projectId: null })

        expect(bustedPaths()).toEqual(['/projects', '/'])
    })
})

describe('muteLibraryAction', function () {
    const base = {
        projectId: 'project-1',
        packageName: 'lodash',
        reason: 'accepted risk',
        expiresAt: null
    }

    it('creates one mute per advisory on the package', async function () {
        const result = await muteLibraryAction({
            ...base,
            advisories: [
                { source: 'npm-audit', advisoryId: 'CVE-2024-1' },
                { source: 'osv', advisoryId: 'GHSA-2' }
            ]
        })

        expect(result).toEqual({ created: 2, skipped: 0 })
        expect(activeMutes().map(function id(m) { return m.advisoryId }).sort()).toEqual(['CVE-2024-1', 'GHSA-2'])
    })

    it('rejects an empty reason before touching the database', async function () {
        await expect(
            muteLibraryAction({ ...base, reason: ' ', advisories: [{ source: 'npm-audit', advisoryId: 'CVE-2024-1' }] })
        ).rejects.toThrow('mute reason is required')
        expect(activeMutes()).toEqual([])
    })

    // Nothing to do means nothing to invalidate either — an empty submission must not churn caches.
    it('returns zero counts and revalidates nothing for an empty advisory list', async function () {
        const result = await muteLibraryAction({ ...base, advisories: [] })

        expect(result).toEqual({ created: 0, skipped: 0 })
        expect(bustedPaths()).toEqual([])
    })

    // The dialog can be re-submitted after a partial failure or a second look, so re-muting an
    // already-muted advisory must be a no-op rather than a duplicate row.
    it('skips an advisory that already has an exactly matching active mute', async function () {
        seedMute('mute-existing')

        const result = await muteLibraryAction({
            ...base,
            advisories: [
                { source: 'npm-audit', advisoryId: 'CVE-2024-1' },
                { source: 'npm-audit', advisoryId: 'CVE-2024-2' }
            ]
        })

        expect(result).toEqual({ created: 1, skipped: 1 })
    })

    // An existing project-scope mute already silences everything in the project, so every advisory
    // is redundant.
    it('skips every advisory when the project is muted wholesale', async function () {
        seedMute('mute-project', { scope: 'project', scanner: null, ecosystem: null, advisoryId: null, packageName: null })

        const result = await muteLibraryAction({
            ...base,
            advisories: [
                { source: 'npm-audit', advisoryId: 'CVE-2024-1' },
                { source: 'osv', advisoryId: 'GHSA-2' }
            ]
        })

        expect(result).toEqual({ created: 0, skipped: 2 })
    })

    // A null projectId on an existing mute means "every project", so it covers this one too.
    it('treats a project-agnostic mute as covering this project', async function () {
        seedMute('mute-global', { projectId: null })

        const result = await muteLibraryAction({ ...base, advisories: [{ source: 'npm-audit', advisoryId: 'CVE-2024-1' }] })

        expect(result).toEqual({ created: 0, skipped: 1 })
    })

    // Likewise a null ecosystem is the legacy wildcard written before mutes were ecosystem-aware.
    it('treats a null-ecosystem mute as covering any ecosystem', async function () {
        seedMute('mute-legacy', { ecosystem: null })

        const result = await muteLibraryAction({
            ...base,
            advisories: [{ source: 'npm-audit', ecosystem: 'PyPI', advisoryId: 'CVE-2024-1' }]
        })

        expect(result).toEqual({ created: 0, skipped: 1 })
    })

    // The inverse, and the one that matters most: a mute on the npm lodash must not silence a PyPI
    // package that happens to share a name and an advisory id.
    it('does not let a mute in one ecosystem cover another', async function () {
        seedMute('mute-npm', { ecosystem: 'npm' })

        const result = await muteLibraryAction({
            ...base,
            advisories: [{ source: 'npm-audit', ecosystem: 'PyPI', advisoryId: 'CVE-2024-1' }]
        })

        expect(result).toEqual({ created: 1, skipped: 0 })
    })

    it('does not let a mute for one source cover another source', async function () {
        seedMute('mute-npm-audit', { scanner: 'npm-audit' })

        const result = await muteLibraryAction({ ...base, advisories: [{ source: 'osv', advisoryId: 'CVE-2024-1' }] })

        expect(result).toEqual({ created: 1, skipped: 0 })
    })

    // An expired mute is no longer silencing anything, so the advisory is fair game again.
    it('ignores an expired mute when deciding what to skip', async function () {
        seedMute('mute-expired', { expiresAt: T0 - 1 })

        const result = await muteLibraryAction({ ...base, advisories: [{ source: 'npm-audit', advisoryId: 'CVE-2024-1' }] })

        expect(result).toEqual({ created: 1, skipped: 0 })
    })

    it('revalidates once at the end rather than per insert', async function () {
        await muteLibraryAction({
            ...base,
            advisories: [
                { source: 'npm-audit', advisoryId: 'CVE-2024-1' },
                { source: 'osv', advisoryId: 'GHSA-2' }
            ]
        })

        expect(bustedPaths()).toEqual(['/projects/project-1', '/projects', '/'])
    })
})

describe('muteLibraryEverywhereAction', function () {
    const base = { packageName: 'lodash', reason: 'accepted risk', expiresAt: null }

    // Each row gets its own project-scoped mute rather than one global null-project mute, so a
    // per-project unmute from a project page still works afterwards.
    it('creates a project-scoped mute per row instead of one global mute', async function () {
        const result = await muteLibraryEverywhereAction({
            ...base,
            rows: [
                { projectId: 'project-1', source: 'npm-audit', advisoryId: 'CVE-2024-1' },
                { projectId: 'project-2', source: 'npm-audit', advisoryId: 'CVE-2024-1' }
            ]
        })

        expect(result).toEqual({ created: 2, skipped: 0 })
        expect(activeMutes().map(function pid(m) { return m.projectId }).sort()).toEqual(['project-1', 'project-2'])
        expect(activeMutes().every(function scoped(m) { return m.scope === 'finding' })).toBe(true)
    })

    it('rejects an empty reason', async function () {
        await expect(
            muteLibraryEverywhereAction({
                ...base,
                reason: '\t',
                rows: [{ projectId: 'project-1', source: 'npm-audit', advisoryId: 'CVE-2024-1' }]
            })
        ).rejects.toThrow('mute reason is required')
    })

    it('returns zero counts and revalidates nothing for an empty row list', async function () {
        const result = await muteLibraryEverywhereAction({ ...base, rows: [] })

        expect(result).toEqual({ created: 0, skipped: 0 })
        expect(bustedPaths()).toEqual([])
    })

    // Partial coverage is the common case: one project was muted individually earlier, the rest were
    // not. The already-muted project is skipped and the others still get their mutes.
    it('skips only the rows already covered', async function () {
        seedMute('mute-p1', { projectId: 'project-1' })

        const result = await muteLibraryEverywhereAction({
            ...base,
            rows: [
                { projectId: 'project-1', source: 'npm-audit', advisoryId: 'CVE-2024-1' },
                { projectId: 'project-2', source: 'npm-audit', advisoryId: 'CVE-2024-1' }
            ]
        })

        expect(result).toEqual({ created: 1, skipped: 1 })
    })

    // A library URL encodes (ecosystem, packageName), so busting a bare package path would miss the
    // page actually being viewed. One bust per distinct ecosystem, not one per row.
    it('busts one library detail page per distinct ecosystem', async function () {
        await muteLibraryEverywhereAction({
            ...base,
            rows: [
                { projectId: 'project-1', source: 'npm-audit', ecosystem: 'npm', advisoryId: 'CVE-2024-1' },
                { projectId: 'project-2', source: 'npm-audit', ecosystem: 'npm', advisoryId: 'CVE-2024-2' },
                { projectId: 'project-2', source: 'osv', ecosystem: 'PyPI', advisoryId: 'CVE-2024-3' }
            ]
        })

        expect(bustedPaths().filter(function isLibrary(p) { return p.startsWith('/libraries/') })).toEqual([
            '/libraries/npm/lodash',
            '/libraries/PyPI/lodash'
        ])
    })

    it('url-encodes the package name in the busted library path', async function () {
        await muteLibraryEverywhereAction({
            ...base,
            packageName: '@scope/pkg',
            rows: [{ projectId: 'project-1', source: 'npm-audit', advisoryId: 'CVE-2024-1' }]
        })

        expect(bustedPaths()).toContain('/libraries/npm/%40scope%2Fpkg')
    })

    it('busts the project page for each project it actually muted', async function () {
        await muteLibraryEverywhereAction({
            ...base,
            rows: [
                { projectId: 'project-1', source: 'npm-audit', advisoryId: 'CVE-2024-1' },
                { projectId: 'project-2', source: 'npm-audit', advisoryId: 'CVE-2024-1' }
            ]
        })

        expect(bustedPaths()).toContain('/projects/project-1')
        expect(bustedPaths()).toContain('/projects/project-2')
    })

    // A wholesale project mute silences the library in THAT project only. Unlike muteLibraryAction,
    // this action spans projects, so the project check has to be evaluated per row against that row's
    // own projectId — comparing against anything shared would let one wholesale-muted project
    // suppress the mutes for every other project in the same submission.
    it('skips only the row whose project is muted wholesale', async function () {
        seedMute('mute-project', { scope: 'project', projectId: 'project-1', scanner: null, ecosystem: null, advisoryId: null, packageName: null })

        const result = await muteLibraryEverywhereAction({
            ...base,
            rows: [
                { projectId: 'project-1', source: 'npm-audit', advisoryId: 'CVE-2024-1' },
                { projectId: 'project-2', source: 'npm-audit', advisoryId: 'CVE-2024-1' }
            ]
        })

        expect(result).toEqual({ created: 1, skipped: 1 })
        expect(activeMutes().filter(function created(m) { return m.scope === 'finding' }).map(function projectOf(m) {
            return m.projectId
        })).toEqual(['project-2'])
    })

    // The library page is busted from the row list, but the project pages come from the set of
    // projects actually mutated — a fully-skipped project keeps its cached page.
    it('does not bust the project page of a row it skipped', async function () {
        seedMute('mute-p1', { projectId: 'project-1' })

        await muteLibraryEverywhereAction({
            ...base,
            rows: [{ projectId: 'project-1', source: 'npm-audit', advisoryId: 'CVE-2024-1' }]
        })

        expect(bustedPaths()).not.toContain('/projects/project-1')
        expect(bustedPaths()).toContain('/libraries/npm/lodash')
    })
})

describe('unmuteAction', function () {
    it('deletes the mute', async function () {
        seedMute('mute-1')

        await unmuteAction('mute-1', 'project-1')

        expect(activeMutes()).toEqual([])
    })

    it('busts the project page, the projects list and the dashboard', async function () {
        seedMute('mute-1')

        await unmuteAction('mute-1', 'project-1')

        expect(bustedPaths()).toEqual(['/projects/project-1', '/projects', '/'])
    })

    it('skips the project page when no project is given', async function () {
        seedMute('mute-1')

        await unmuteAction('mute-1', null)

        expect(bustedPaths()).toEqual(['/projects', '/'])
    })

    it('is a no-op for an id that does not exist', async function () {
        await expect(unmuteAction('missing', null)).resolves.toBeUndefined()
    })
})

describe('unmuteManyAction', function () {
    // A merged finding row in the UI stands in for one mute per underlying (source, advisoryId)
    // identity, so lifting it has to delete all of them or the row comes back half-muted.
    it('deletes every listed mute', async function () {
        seedMute('mute-1')
        seedMute('mute-2', { advisoryId: 'CVE-2024-2' })
        seedMute('mute-3', { advisoryId: 'CVE-2024-3' })

        await unmuteManyAction(['mute-1', 'mute-2'], 'project-1')

        expect(activeMutes().map(function id(m) { return m.id })).toEqual(['mute-3'])
    })

    it('returns without revalidating for an empty id list', async function () {
        await unmuteManyAction([], 'project-1')

        expect(bustedPaths()).toEqual([])
    })

    it('revalidates once at the end rather than per delete', async function () {
        seedMute('mute-1')
        seedMute('mute-2', { advisoryId: 'CVE-2024-2' })

        await unmuteManyAction(['mute-1', 'mute-2'], 'project-1')

        expect(bustedPaths()).toEqual(['/projects/project-1', '/projects', '/'])
    })

    it('skips the project page when no project is given', async function () {
        seedMute('mute-1')

        await unmuteManyAction(['mute-1'], null)

        expect(bustedPaths()).toEqual(['/projects', '/'])
    })
})
