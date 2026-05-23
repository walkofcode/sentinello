import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { isAnyScanInFlight, isScanInFlightForRoot, listRoots } from '@sentinello/db'
import { RootList } from '@/components/settings/root-list'
import { getDb, getSqlite } from '@/lib/db'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('roots.metaTitle') }
}

export default async function RootsSettingsPage() {
    const db = getDb()
    const sqlite = getSqlite()
    const now = Date.now()
    const roots = listRoots(db)
    const stmt = sqlite.prepare('SELECT root_id AS rootId, COUNT(*) AS n FROM projects GROUP BY root_id')
    const countRows = stmt.all() as { rootId: string; n: number }[]
    const countsByRootId = new Map<string, number>()
    for (const row of countRows) countsByRootId.set(row.rootId, row.n)
    const anyInFlight = isAnyScanInFlight(db, now)
    const rows = roots.map(function toRow(r) {
        return {
            id: r.id,
            path: r.path,
            label: r.label,
            projectCount: countsByRootId.get(r.id) || 0,
            scanning: isScanInFlightForRoot(db, r.id, now)
        }
    })
    return <RootList roots={rows} anyInFlight={anyInFlight} />
}
