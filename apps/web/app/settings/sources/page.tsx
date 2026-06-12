import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { getConfigValue, getSourceEnabled } from '@sentinello/db'
import {
    DEFAULT_ECOSYSTEM,
    ECOSYSTEMS,
    LEGACY_SOURCE_CONFIG_KEYS,
    SOURCES,
    sourceStatusKey,
    sourceSupportsEcosystem,
    type SourceStatus
} from '@sentinello/core'
import { SourcesForm, type SourceCellVM, type LanguageRowVM } from '@/components/settings/sources-form'
import { getDb } from '@/lib/db'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('sources.metaTitle') }
}

export default async function SourcesSettingsPage() {
    const db = getDb()
    // Build the Languages × Sources matrix from the central registry so Settings, filters, and the backend
    // never drift on ecosystem/source identity. Each cell carries its persisted enabled flag (read through
    // getSourceEnabled, which applies the per-cell key, legacy-key fallback, and per-source default) and,
    // for cache-backed sources, the worker's last sync-status snapshot.
    const rows: LanguageRowVM[] = ECOSYSTEMS.map(function toRow(eco) {
        const cells: SourceCellVM[] = SOURCES.filter(function supports(source) {
            return sourceSupportsEcosystem(source.id, eco.id)
        }).map(function toCell(source): SourceCellVM {
            // Status snapshots read the per-cell key; the npm cell additionally falls back to the legacy
            // flat key for the brief window before the worker boot migrates them. Non-cache-backed sources
            // (npm-audit) have no snapshot.
            let status: SourceStatus | null = null
            if (source.cacheBacked) {
                status = getConfigValue<SourceStatus>(db, sourceStatusKey(source.id, eco.id))
                if (!status && eco.id === DEFAULT_ECOSYSTEM) {
                    const legacyKey = source.id === 'osv' ? LEGACY_SOURCE_CONFIG_KEYS.osvStatus : LEGACY_SOURCE_CONFIG_KEYS.gemnasiumStatus
                    status = getConfigValue<SourceStatus>(db, legacyKey)
                }
            }
            return {
                source: source.id,
                ecosystem: eco.id,
                displayName: source.displayName,
                enabled: getSourceEnabled(db, source.id, eco.id),
                cacheBacked: source.cacheBacked,
                status
            }
        })
        return {
            ecosystem: eco.id,
            language: eco.language,
            displayName: eco.displayName,
            cells
        }
    })
    return <SourcesForm rows={rows} />
}
