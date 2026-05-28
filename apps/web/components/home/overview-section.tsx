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
        <div className={'grid grid-cols-1 gap-4 ' + (pendingTotal > 0 ? 'lg:grid-cols-3' : 'sm:grid-cols-2')}>
            <Card>
                <CardContent className="flex h-full flex-wrap items-center gap-x-8 gap-y-3 pt-5">
                    <div>
                        <CardValue>
                            {summary.projectsWithFindings}
                            <span className="text-muted-foreground"> / {summary.totalActiveProjects}</span>
                        </CardValue>
                        <div className="mt-1 text-xs text-muted-foreground">{t('projectsTitle')}</div>
                    </div>
                    <div>
                        <CardValue>{librariesCount}</CardValue>
                        <div className="mt-1 text-xs text-muted-foreground">{t('librariesTitle')}</div>
                    </div>
                    {pendingTotal > 0 ? (
                        <div>
                            <CardValue>{pendingTotal}</CardValue>
                            <div className="mt-1 text-xs text-muted-foreground">{t('pendingFindings')}</div>
                        </div>
                    ) : null}
                </CardContent>
            </Card>
            {pendingTotal > 0 ? (
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
                    </CardContent>
                </Card>
            ) : null}
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
    )
}

