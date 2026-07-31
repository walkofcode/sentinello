import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revalidatePath } from 'next/cache'
import { getConfigValue, setConfigValue } from '@sentinello/db'
import { DEFAULT_EXPORT_PROMPT } from '@sentinello/core'
import {
    closePortalTestDb,
    finding,
    openPortalTestDb,
    scanProject,
    seedProject,
    seedRoot,
    type PortalTestDb
} from '@/lib/portal-test-db.fixture'
import {
    exportLibraryAdvisoryMarkdownAction,
    exportProjectAdvisoryMarkdownAction,
    resetExportPromptAction,
    updateExportPromptAction
} from './export'

vi.mock('next/cache', function stubNextCache() {
    return { revalidatePath: vi.fn() }
})

let handle: PortalTestDb

beforeEach(async function setup() {
    vi.mocked(revalidatePath).mockClear()
    handle = await openPortalTestDb('export-action')
    seedRoot(handle.db)
    seedProject(handle.db, 'project-1', { name: 'Billing API' })
    seedProject(handle.db, 'project-2', { name: 'Web Store' })
})

afterEach(async function teardown() {
    await closePortalTestDb(handle)
})

describe('exportProjectAdvisoryMarkdownAction', function () {
    beforeEach(function seedFindings() {
        scanProject(handle.db, 'project-1', [
            finding({ packageName: 'lodash', advisoryId: 'CVE-2024-1', severity: 'high' }),
            finding({ packageName: 'axios', advisoryId: 'CVE-2024-2', severity: 'low', isProd: false, isDev: true })
        ])
    })

    it('returns a dated filename slugged from the project name', async function () {
        const result = await exportProjectAdvisoryMarkdownAction('project-1', 'all')

        expect(result.filename).toMatch(/^sentinello-billing-api-advisories-\d{4}-\d{2}-\d{2}\.md$/)
    })

    it('includes the findings in the markdown', async function () {
        const result = await exportProjectAdvisoryMarkdownAction('project-1', 'all')

        expect(result.markdown).toContain('lodash')
        expect(result.markdown).toContain('CVE-2024-1')
    })

    it('honours the dependency-type filter', async function () {
        const prod = await exportProjectAdvisoryMarkdownAction('project-1', 'prod')

        expect(prod.markdown).toContain('lodash')
        expect(prod.markdown).not.toContain('axios')
    })

    // This is a client-callable server action, so every field on the return value is serialized to
    // the browser on each click. The builder returns far more than this; the action narrows it to
    // exactly what the download button reads.
    it('returns only the filename and markdown fields', async function () {
        const result = await exportProjectAdvisoryMarkdownAction('project-1', 'all')

        expect(Object.keys(result).sort()).toEqual(['filename', 'markdown'])
    })

    it('throws on an unknown project', async function () {
        await expect(exportProjectAdvisoryMarkdownAction('missing', 'all')).rejects.toThrow('project not found: missing')
    })

    // depType arrives from a client component, so it is parsed rather than trusted — an unexpected
    // value must fail loudly instead of silently degrading to an unfiltered export.
    it('rejects a dependency-type value outside the allowed set', async function () {
        await expect(
            exportProjectAdvisoryMarkdownAction('project-1', 'everything' as never)
        ).rejects.toThrow()
    })
})

describe('exportLibraryAdvisoryMarkdownAction', function () {
    beforeEach(function seedFindings() {
        scanProject(handle.db, 'project-1', [finding({ packageName: 'lodash', advisoryId: 'CVE-2024-1' })])
        scanProject(handle.db, 'project-2', [finding({ packageName: 'lodash', advisoryId: 'CVE-2024-9' })])
    })

    it('gathers the package usage across every project', async function () {
        const result = await exportLibraryAdvisoryMarkdownAction('lodash', 'all')

        expect(result.markdown).toContain('CVE-2024-1')
        expect(result.markdown).toContain('CVE-2024-9')
    })

    it('names the file after the package', async function () {
        const result = await exportLibraryAdvisoryMarkdownAction('lodash', 'all')

        expect(result.filename).toMatch(/^sentinello-lodash-advisories-\d{4}-\d{2}-\d{2}\.md$/)
    })

    it('trims the package name before querying', async function () {
        const result = await exportLibraryAdvisoryMarkdownAction('  lodash  ', 'all')

        expect(result.markdown).toContain('CVE-2024-1')
    })

    it('rejects an empty or whitespace-only package name', async function () {
        await expect(exportLibraryAdvisoryMarkdownAction('   ', 'all')).rejects.toThrow('packageName is required')
    })

    // A library is identified by (ecosystem, packageName). Without the ecosystem argument reaching
    // the query, a same-named package in another ecosystem would be folded into the same document.
    it('scopes the export to one ecosystem when given', async function () {
        scanProject(handle.db, 'project-1', [
            finding({ packageName: 'lodash', advisoryId: 'PYSEC-1', ecosystem: 'PyPI', scanner: 'osv', source: 'osv' })
        ], { scanner: 'osv', ecosystem: 'PyPI' })

        const npmOnly = await exportLibraryAdvisoryMarkdownAction('lodash', 'all', 'npm')

        expect(npmOnly.markdown).toContain('CVE-2024-1')
        expect(npmOnly.markdown).not.toContain('PYSEC-1')
    })

    it('produces a document even when the package has no findings', async function () {
        const result = await exportLibraryAdvisoryMarkdownAction('not-installed-anywhere', 'all')

        expect(result.markdown).toContain(DEFAULT_EXPORT_PROMPT.slice(0, 40))
    })

    it('uses the default prompt when none is configured', async function () {
        const result = await exportLibraryAdvisoryMarkdownAction('lodash', 'all')

        expect(result.markdown).toContain(DEFAULT_EXPORT_PROMPT.slice(0, 40))
    })

    it('uses the operator-configured prompt when one is stored', async function () {
        setConfigValue(handle.db, 'markdownExportPrompt', 'Fix these before Friday.')

        const result = await exportLibraryAdvisoryMarkdownAction('lodash', 'all')

        expect(result.markdown).toContain('Fix these before Friday.')
    })

    // The library-usage query does not select the dep path or fix columns, so the action marks every
    // row as having no known fix. That makes the formatter print its "check the advisory" guidance
    // rather than inventing an upgrade target the data cannot support.
    // Note the finding fixture DOES carry fixVersion 4.17.21 — the project export renders it as an
    // upgrade target, and this one still must not, because the data behind a library export cannot
    // support the claim.
    it('never claims a fix version is available', async function () {
        const result = await exportLibraryAdvisoryMarkdownAction('lodash', 'all')

        expect(result.markdown).toContain('no fix available yet')
        expect(result.markdown).not.toContain('**Fix:** upgrade to')
    })

    it('rejects a dependency-type value outside the allowed set', async function () {
        await expect(exportLibraryAdvisoryMarkdownAction('lodash', 'weekly' as never)).rejects.toThrow()
    })
})

describe('updateExportPromptAction', function () {
    it('persists the prompt', async function () {
        await updateExportPromptAction('Fix these before Friday.')

        expect(getConfigValue<string>(handle.db, 'markdownExportPrompt')).toBe('Fix these before Friday.')
    })

    it('trims the prompt before storing', async function () {
        await updateExportPromptAction('   Fix these.   ')

        expect(getConfigValue<string>(handle.db, 'markdownExportPrompt')).toBe('Fix these.')
    })

    // Rejections come back as { ok: false, errorText } rather than as a throw. A thrown Server Action
    // message is replaced by Next.js's production redaction notice before the client sees it, so
    // anything written for the operator has to be returned. See lib/actions/action-result.ts.
    //
    // Reachable from the UI: Save is gated on the textarea being dirty, and emptying it makes it dirty.
    it('rejects an empty or whitespace-only prompt', async function () {
        const result = await updateExportPromptAction('   ')

        expect(result).toEqual({ ok: false, errorText: 'prompt cannot be empty' })
        expect(getConfigValue<string>(handle.db, 'markdownExportPrompt')).toBeNull()
    })

    it('rejects a prompt longer than 20000 characters', async function () {
        const result = await updateExportPromptAction('x'.repeat(20_001))

        expect(result.ok).toBe(false)
        expect(getConfigValue<string>(handle.db, 'markdownExportPrompt')).toBeNull()
    })

    it('accepts a prompt at exactly the length limit', async function () {
        await expect(updateExportPromptAction('x'.repeat(20_000))).resolves.toEqual({ ok: true })
    })

    it('busts the export settings page', async function () {
        await updateExportPromptAction('Fix these.')

        expect(vi.mocked(revalidatePath).mock.calls).toEqual([['/settings/export']])
    })
})

describe('resetExportPromptAction', function () {
    // "Reset to default" writes null rather than deleting the row — the resolver treats null and
    // empty alike as "use the built-in default", so no separate delete path is needed.
    it('clears the override so the default prompt is used again', async function () {
        await updateExportPromptAction('Fix these before Friday.')

        await resetExportPromptAction()

        expect(getConfigValue<string>(handle.db, 'markdownExportPrompt')).toBeNull()
        const result = await exportLibraryAdvisoryMarkdownAction('lodash', 'all')
        expect(result.markdown).toContain(DEFAULT_EXPORT_PROMPT.slice(0, 40))
        expect(result.markdown).not.toContain('Fix these before Friday.')
    })

    it('busts the export settings page', async function () {
        await resetExportPromptAction()

        expect(vi.mocked(revalidatePath).mock.calls).toEqual([['/settings/export']])
    })
})
