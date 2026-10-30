import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getSourceEnabled, listProjectScanStates } from '@sentinello/db'
import { STABLE_ECOSYSTEMS, SOURCES, sourceSupportsEcosystem } from '@sentinello/core'
import { SourceReferenceTable } from '@/components/settings/source-reference-table'
import { SourcesForm, type SourceCellVM, type LanguageRowVM } from '@/components/settings/sources-form'
import { getDb } from '@/lib/db'
import { projectsWithoutSource } from '@/lib/project-state'
import { readSourceCellStatus } from '@/lib/source-status'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('sources.metaTitle') }
}

export default async function SourcesSettingsPage() {
    const db = getDb()
    // Build the Languages × Sources matrix from the central registry so Settings, filters, and the backend
    // never drift on ecosystem/source identity. Each cell carries its persisted enabled flag (read through
    // getSourceEnabled, which applies the per-cell key, legacy-key fallback, and per-source default) and,
    // for cache-backed sources, the worker's last sync-status snapshot (readSourceCellStatus).
    // Per language, the projects nothing scans because no source is enabled for it: what the "Turn on"
    // actions are offered for. Read from the same scan states the dashboard and project pages show.
    const withoutSource = projectsWithoutSource(listProjectScanStates(db).values()).ecosystems
    const rows: LanguageRowVM[] = STABLE_ECOSYSTEMS.map(function toRow(eco) {
        const cells: SourceCellVM[] = SOURCES.filter(function supports(source) {
            return sourceSupportsEcosystem(source.id, eco.id)
        }).map(function toCell(source): SourceCellVM {
            return {
                source: source.id,
                ecosystem: eco.id,
                displayName: source.displayName,
                enabled: getSourceEnabled(db, source.id, eco.id),
                cacheBacked: source.cacheBacked,
                // `defaultEnabled` IS the definition of the built-in source: the one that is on out of
                // the box, which is exactly the one an operator must not be able to switch off.
                builtIn: source.defaultEnabled,
                status: readSourceCellStatus(db, source.id, eco.id)
            }
        })
        return {
            ecosystem: eco.id,
            language: eco.language,
            displayName: eco.displayName,
            cells,
            projectsWithoutSource: withoutSource.find(function same(entry) { return entry.ecosystem === eco.id })?.projects ?? 0
        }
    })
    return (
        <div className="space-y-6">
            <SourcesForm rows={rows} />
            <SourceReferenceTable />
        </div>
    )
}
