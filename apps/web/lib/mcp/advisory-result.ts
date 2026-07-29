import type { PaginatedAdvisoryMarkdown } from '@sentinello/core'

// Shaping the get_project_advisory response lives here, apart from the tool registration, so it can be
// unit-tested without standing up a database or an MCP server. The bug this file exists to prevent
// shipped precisely because the registration file had no test seam.

export type AdvisoryToolResult = {
    content: { type: 'text'; text: string }[]
}

export type AdvisoryNoteInput = {
    page: PaginatedAdvisoryMarkdown
    mutedExcludedCount: number
    projectId: string
    depType: string
}

// Muting is a human's recorded accepted-risk decision, so the document says what was left out rather
// than rendering a quietly shorter list. Without this the document can read "_No current findings._"
// under a prompt whose stated goal is zero — exactly the silent zero that prompt warns against.
function mutedNote(count: number): string {
    if (count <= 0) return ''
    const one = count === 1
    const subject = one
        ? '1 advisory is excluded from this document because it is muted'
        : count + ' advisories are excluded from this document because they are muted'
    return (
        '\n> Note: ' + subject + ' in Sentinello. Muting records a human\'s accepted-risk decision — ' +
        'do not unmute or act on ' + (one ? 'it' : 'them') + ' as part of this work.\n'
    )
}

// A page that stops short must say so AND say how to continue, naming the literal next call. An agent
// that only sees a document ending mid-list will read the remainder as clean.
function continuationNote(input: AdvisoryNoteInput): string {
    const { page } = input
    if (page.nextOffset === null) return ''
    const remaining = page.total - (page.offset + page.rendered)
    return (
        '\n> **This document is incomplete.** Showing advisories ' + (page.offset + 1) + '–' +
        (page.offset + page.rendered) + ' of ' + page.total + '; ' + remaining +
        ' did not fit in one response. Do not treat the list above as the full set. Retrieve the rest with:\n' +
        '> `get_project_advisory({ projectId: "' + input.projectId + '", depType: "' + input.depType +
        '", offset: ' + page.nextOffset + ', includePrompt: false })`\n'
    )
}

// Returns the document as a single text content block and DELIBERATELY sets no `structuredContent`.
// Clients prefer structuredContent over content whenever both are present, so a metadata-only
// structuredContent here would win and the document itself would never reach the model — which is
// exactly the bug this replaced. The other tools in this server return row sets and are right to send
// both; this one's payload IS the prose, so it travels on one channel only. Do not "restore symmetry".
export function buildAdvisoryToolResult(input: AdvisoryNoteInput): AdvisoryToolResult {
    const text = input.page.markdown + mutedNote(input.mutedExcludedCount) + continuationNote(input)
    return { content: [{ type: 'text', text }] }
}
