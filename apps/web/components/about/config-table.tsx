import { getTranslations } from 'next-intl/server'

// Variable names and default values are literal (language-independent); only the Purpose column is
// translated. Mirror of network-activity-table.tsx. Keep this in sync with the README "Configuration"
// table and the env vars the app actually reads.
type Row = {
    variable: string
    def: string
    purposeKey: string
}

const ROWS: Row[] = [
    { variable: 'PORT', def: '3000', purposeKey: 'configRows.port' },
    { variable: 'SENTINELLO_DB_PATH', def: '/app/data/sentinello.sqlite', purposeKey: 'configRows.dbPath' },
    { variable: 'SENTINELLO_PORTAL_BASE_URL', def: 'http://localhost:3870', purposeKey: 'configRows.portalBaseUrl' },
    { variable: 'ME_NAME', def: 'anonymous', purposeKey: 'configRows.meName' },
    { variable: 'SENTINELLO_PORTAL_TOKEN', def: '—', purposeKey: 'configRows.portalToken' },
    { variable: 'SENTINELLO_VERSION', def: 'dev', purposeKey: 'configRows.version' },
    { variable: 'SENTINELLO_UPDATE_FEED_URL', def: 'GitHub Releases API', purposeKey: 'configRows.updateFeedUrl' },
    { variable: 'SENTINELLO_WEBHOOK_STRICT', def: '—', purposeKey: 'configRows.webhookStrict' },
    { variable: 'SENTINELLO_OSV_FEED_URL', def: 'OSV bucket', purposeKey: 'configRows.osvFeedUrl' },
    { variable: 'SENTINELLO_OSV_DB_PATH', def: '<data dir>/osv.db', purposeKey: 'configRows.osvDbPath' }
]

export async function ConfigTable() {
    const t = await getTranslations('About')
    return (
        <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                        <th className="px-4 py-2 font-semibold">{t('configColVariable')}</th>
                        <th className="px-4 py-2 font-semibold">{t('configColDefault')}</th>
                        <th className="px-4 py-2 font-semibold">{t('configColPurpose')}</th>
                    </tr>
                </thead>
                <tbody>
                    {ROWS.map(function row(r) {
                        return (
                            <tr key={r.variable} className="border-t align-top">
                                <td className="px-4 py-2 font-mono text-xs">{r.variable}</td>
                                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{r.def}</td>
                                <td className="px-4 py-2">{t(r.purposeKey)}</td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}
