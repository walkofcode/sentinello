import { getTranslations } from 'next-intl/server'
import {
    GEMNASIUM_REQUIRED_FREE_BYTES,
    GEMNASIUM_SEED_DOWNLOAD_BYTES,
    OSV_REQUIRED_FREE_BYTES,
    OSV_SEED_DOWNLOAD_BYTES,
    SOURCES,
    type SourceId
} from '@sentinello/core'

const MIB = 1024 * 1024

// Sizes ride in as ICU params rather than being written into ten catalogues. The constants in
// packages/core/src/sources.ts are measured figures carrying a "re-measure when this drifts" note,
// and prose that repeated them would go stale the first time one was re-measured — in ten files at
// once, silently.
const DOWNLOAD_PARAMS: Partial<Record<SourceId, { mb: number; freeMb: number }>> = {
    osv: {
        mb: Math.round(OSV_SEED_DOWNLOAD_BYTES / MIB),
        freeMb: Math.round(OSV_REQUIRED_FREE_BYTES / MIB)
    },
    gemnasium: {
        mb: Math.round(GEMNASIUM_SEED_DOWNLOAD_BYTES / MIB),
        freeMb: Math.round(GEMNASIUM_REQUIRED_FREE_BYTES / MIB)
    }
}

// Message-key stems per source. Driven off SOURCES rather than a hand-written row list so a source
// added to the registry cannot quietly go undocumented — it fails loudly on the missing key instead.
const KEY_STEM: Record<SourceId, string> = {
    'npm-audit': 'npmAudit',
    osv: 'osv',
    gemnasium: 'gemnasium'
}

// What each source is, kept apart from the control that turns it on. The toggles above answer "is
// this running?"; this answers "what am I turning on, what does it cost me, and when does it act?".
export async function SourceReferenceTable() {
    const t = await getTranslations('Settings')
    return (
        <section className="space-y-3">
            <h2 className="text-sm font-semibold">{t('sources.aboutTitle')}</h2>
            <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-left text-sm">
                    <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                        <tr>
                            <th className="px-4 py-2 font-semibold">{t('sources.colSource')}</th>
                            <th className="px-4 py-2 font-semibold">{t('sources.colAdds')}</th>
                            <th className="px-4 py-2 font-semibold">{t('sources.colDownloads')}</th>
                            <th className="px-4 py-2 font-semibold">{t('sources.colRuns')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {SOURCES.map(function sourceRow(source) {
                            const stem = KEY_STEM[source.id]
                            return (
                                <tr key={source.id} className="border-t align-top">
                                    <td className="px-4 py-2 font-medium">{source.displayName}</td>
                                    <td className="px-4 py-2 text-muted-foreground">
                                        {t('sources.' + stem + 'Adds')}
                                    </td>
                                    <td className="px-4 py-2 text-muted-foreground">
                                        {t('sources.' + stem + 'Downloads', DOWNLOAD_PARAMS[source.id])}
                                    </td>
                                    <td className="px-4 py-2 text-muted-foreground">
                                        {t('sources.' + stem + 'Runs')}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    )
}
