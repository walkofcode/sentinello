import { describe, expect, it } from 'vitest'
import type { PaginatedAdvisoryMarkdown } from '@sentinello/core'
import { buildAdvisoryToolResult } from './advisory-result'

// Sentinello 2.5.0 shipped this tool returning the document in `content` AND a metadata-only
// `structuredContent`. Clients prefer structuredContent whenever both are present, so every caller got
// ~200 bytes of metadata and never saw the document. These tests pin the shape that fixes that.

function pageOf(overrides: Partial<PaginatedAdvisoryMarkdown> = {}): PaginatedAdvisoryMarkdown {
    return {
        markdown: '# Sentinello advisory export — api\n\n## Findings\n\n### 1. `lodash@4.17.20` — high\n',
        offset: 0,
        rendered: 1,
        total: 1,
        nextOffset: null,
        ...overrides
    }
}

function resultOf(overrides: Partial<PaginatedAdvisoryMarkdown> = {}, mutedExcludedCount = 0) {
    return buildAdvisoryToolResult({
        page: pageOf(overrides),
        mutedExcludedCount,
        projectId: 'proj-1',
        depType: 'prod'
    })
}

describe('buildAdvisoryToolResult', function () {
    // The regression guard for the shipped bug. If this ever fails, the document has stopped reaching
    // MCP clients again, however healthy the handler looks.
    it('never sets structuredContent, which would win over the document', function () {
        expect('structuredContent' in resultOf()).toBe(false)
    })

    it('returns the document itself as a single text block', function () {
        const result = resultOf()
        expect(result.content).toHaveLength(1)
        expect(result.content[0].type).toBe('text')
        expect(result.content[0].text).toContain('### 1. `lodash@4.17.20` — high')
    })

    it('says nothing about mutes when nothing is muted', function () {
        expect(resultOf({}, 0).content[0].text).not.toContain('muted')
    })

    // A shorter list with no explanation reads as good news; the count has to be stated.
    it('states how many advisories were withheld as muted', function () {
        expect(resultOf({}, 3).content[0].text).toContain('3 advisories are excluded')
    })

    it('uses the singular for exactly one muted advisory', function () {
        const text = resultOf({}, 1).content[0].text
        expect(text).toContain('1 advisory is excluded')
        expect(text).not.toContain('advisories are excluded')
    })

    it('adds no continuation notice when the document is complete', function () {
        expect(resultOf().content[0].text).not.toContain('incomplete')
    })

    describe('when the document was cut to fit', function () {
        const text = resultOf({ rendered: 24, total: 36, nextOffset: 24 }).content[0].text

        it('says plainly that the list is not the full set', function () {
            expect(text).toContain('This document is incomplete')
            expect(text).toContain('Do not treat the list above as the full set')
        })

        it('reports the range covered and the number withheld', function () {
            expect(text).toContain('advisories 1–24 of 36')
            expect(text).toContain('12 did not fit')
        })

        // Naming the literal call is the point: an agent should not have to infer the offset.
        it('spells out the exact follow-up call, including the offset to resume from', function () {
            expect(text).toContain('offset: 24')
            expect(text).toContain('projectId: "proj-1"')
            expect(text).toContain('depType: "prod"')
            expect(text).toContain('includePrompt: false')
        })
    })

    it('reports the range of a later page relative to the whole set', function () {
        const text = resultOf({ offset: 24, rendered: 6, total: 36, nextOffset: 30 }).content[0].text
        expect(text).toContain('advisories 25–30 of 36')
        expect(text).toContain('offset: 30')
    })
})
