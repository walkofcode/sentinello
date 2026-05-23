import type { DashboardSummary } from '@sentinello/db'
import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardHeader, CardTitle, CardValue } from '@/components/ui/card'
import { SeverityPill } from '@/components/ui/severity-pill'
import { formatRelativeTime } from '@/lib/format'
import { ScanAllButton } from '@/components/home/scan-all-button'

type Props = {
    summary: DashboardSummary
    librariesCount: number
    now: number
    anyInFlight: boolean
}

export async function OverviewSection({ summary, librariesCount, now, anyInFlight }: Props) {
    const t = await getTranslations('Home')
    const tTime = await getTranslations('Time')
    const c = summary.severityCounts
    const pendingTotal = c.critical + c.high + c.moderate + c.low + c.info
    return (
        <div className="space-y-6">
            <header className="flex items-baseline justify-between">
                <h2 className="text-2xl font-semibold tracking-tight">{t('overviewTitle')}</h2>
            </header>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Card>
                    <CardHeader>
                        <CardTitle>{t('projectsWithFindings')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <CardValue>
                            {summary.projectsWithFindings}
                            <span className="text-muted-foreground"> / {summary.totalActiveProjects}</span>
                        </CardValue>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>{t('vulnerableLibraries')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <CardValue>{librariesCount}</CardValue>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>{t('pendingFindings')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <CardValue>{pendingTotal}</CardValue>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle>{t('lastScan')}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex items-center justify-between gap-3">
                        <CardValue className="text-2xl">{formatRelativeTime(summary.lastScanFinishedAt, tTime, now)}</CardValue>
                        <ScanAllButton scanning={anyInFlight} />
                    </CardContent>
                </Card>
            </div>
            <Card>
                <CardHeader>
                    <CardTitle>{t('severityBreakdown')}</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap gap-2">
                        <SeverityPill variant="critical" count={summary.severityCounts.critical} />
                        <SeverityPill variant="high" count={summary.severityCounts.high} />
                        <SeverityPill variant="moderate" count={summary.severityCounts.moderate} />
                        <SeverityPill variant="low" count={summary.severityCounts.low} />
                        <SeverityPill variant="info" count={summary.severityCounts.info} />
                    </div>
                    <p className="mt-4 text-xs text-muted-foreground">
                        {t('severityBreakdownNote')}
                    </p>
                </CardContent>
            </Card>
        </div>
    )
}

