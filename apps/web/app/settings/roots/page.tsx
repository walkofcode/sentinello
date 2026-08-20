import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { isScanInFlightForRoot, listRoots } from '@sentinello/db'
import { RootList } from '@/components/settings/root-list'
import { getDb, getSqlite } from '@/lib/db'

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Settings')
    return { title: t('roots.metaTitle') }
}

export default async function RootsSettingsPage() {
    const db = getDb()
    const sqlite = getSqlite()
    // eslint-disable-next-line react-hooks/purity -- async Server Component: renders once, never re-renders
    const now = Date.now()
    const roots = listRoots(db)
    // Two numbers per root, deliberately. `n` is every discovered project — muting a project does not
    // undiscover it, and deleting the root WILL delete it, so the delete-confirmation blast radius must
    // stay the true total. `muted` is reported alongside so the column can show how much of that total is
    // silenced without ever understating what a delete would remove.
    const stmt = sqlite.prepare(`
        SELECT
            p.root_id AS rootId,
            COUNT(*) AS n,
            SUM(CASE WHEN EXISTS (
                SELECT 1 FROM mutes m
                WHERE m.scope = 'project'
                  AND m.project_id = p.id
                  AND (m.expires_at IS NULL OR m.expires_at > ?)
            ) THEN 1 ELSE 0 END) AS muted
        FROM projects p
        GROUP BY p.root_id
    `)
    const countRows = stmt.all(now) as { rootId: string; n: number; muted: number }[]
    const countsByRootId = new Map<string, number>()
    const mutedByRootId = new Map<string, number>()
    for (const row of countRows) {
        countsByRootId.set(row.rootId, row.n)
        mutedByRootId.set(row.rootId, row.muted)
    }
    const rows = roots.map(function toRow(r) {
        return {
            id: r.id,
            path: r.path,
            label: r.label,
            projectCount: countsByRootId.get(r.id) || 0,
            mutedProjectCount: mutedByRootId.get(r.id) || 0,
            scanning: isScanInFlightForRoot(db, r.id, now)
        }
    })
    return <RootList roots={rows} />
}
