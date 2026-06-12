import { getTranslations } from 'next-intl/server'

type Row = {
    destination: string
    purposeKey: string
    whenKey: string
    disableKey: string
}

const ROWS: Row[] = [
    {
        destination: 'registry.npmjs.org',
        purposeKey: 'rows.npm.purpose',
        whenKey: 'rows.npm.when',
        disableKey: 'rows.npm.disable'
    },
    {
        destination: 'osv-vulnerabilities.storage.googleapis.com/<ecosystem>',
        purposeKey: 'rows.osv.purpose',
        whenKey: 'rows.osv.when',
        disableKey: 'rows.osv.disable'
    },
    {
        destination: 'gitlab.com (gemnasium archive)',
        purposeKey: 'rows.gemnasium.purpose',
        whenKey: 'rows.gemnasium.when',
        disableKey: 'rows.gemnasium.disable'
    },
    {
        destination: 'api.github.com (releases)',
        purposeKey: 'rows.github.purpose',
        whenKey: 'rows.github.when',
        disableKey: 'rows.github.disable'
    },
    {
        destination: 'GHCR / Docker Hub',
        purposeKey: 'rows.image.purpose',
        whenKey: 'rows.image.when',
        disableKey: 'rows.image.disable'
    }
]

export async function NetworkActivityTable() {
    const t = await getTranslations('About')
    return (
        <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                        <th className="px-4 py-2 font-semibold">{t('tableDestination')}</th>
                        <th className="px-4 py-2 font-semibold">{t('tablePurpose')}</th>
                        <th className="px-4 py-2 font-semibold">{t('tableWhen')}</th>
                        <th className="px-4 py-2 font-semibold">{t('tableDisable')}</th>
                    </tr>
                </thead>
                <tbody>
                    {ROWS.map(function row(r) {
                        return (
                            <tr key={r.destination} className="border-t align-top">
                                <td className="px-4 py-2 font-mono text-xs">{r.destination}</td>
                                <td className="px-4 py-2">{t(r.purposeKey)}</td>
                                <td className="px-4 py-2">{t(r.whenKey)}</td>
                                <td className="px-4 py-2 text-muted-foreground">{t(r.disableKey)}</td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}
