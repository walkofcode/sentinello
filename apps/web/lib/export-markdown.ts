// The advisory-export builder moved to @sentinello/core so the worker (webhook 'text' flavor) and
// the web portal share one implementation. This barrel keeps the existing '@/lib/export-markdown'
// import path working for the portal's export action and Settings → Export page.
export {
    DEFAULT_EXPORT_PROMPT,
    resolveExportPrompt,
    buildAdvisoryMarkdown,
    buildExportFilename,
    type ExportScope,
    type ExportFinding
} from '@sentinello/core'
