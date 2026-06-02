'use client'

import { useTranslations } from 'next-intl'
import type { SeverityCounts } from '@sentinello/db'
import { Card, CardContent, CardHeader, CardTitle, CardValue } from '@/components/ui/card'
import { SeverityPill } from '@/components/ui/severity-pill'
import { formatRelativeTime } from '@/lib/format'
import { ScanAllButton } from '@/components/home/scan-all-button'

// The project/severity counts are computed client-side from the filtered project list (see
// ProjectsFilterView) so the overview tracks the active filters. Truly-global bits (libraries count,
// last-scan time) are passed straight through from the server.
type OverviewCounts = {
    projectsWithFindings: number
    totalProjects: number
    severityCounts: SeverityCounts
}

type Props = {
    counts: OverviewCounts
    librariesCount: number
    lastScanFinishedAt: number | null
    now: number
    anyInFlight: boolean
}

export function OverviewSection({ counts, librariesCount, lastScanFinishedAt, now, anyInFlight }: Props) {
    const t = useTranslations('Home')
    const tTime = useTranslations('Time')
    const c = counts.severityCounts
    const pendingTotal = c.critical + c.high + c.moderate + c.low + c.info
    return (
        <div className={'grid grid-cols-1 gap-4 ' + (pendingTotal > 0 ? 'lg:grid-cols-2' : '')}>
            <Card>
                <CardContent className="flex h-full flex-wrap items-center gap-x-8 gap-y-3 pt-5">
                    <div>
                        <CardValue>
                            {counts.projectsWithFindings}
                            <span className="text-muted-foreground"> / {counts.totalProjects}</span>
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
                    {/* Last scan label on top, Scan-now button below — pushed to the right of the metrics card. */}
                    <div className="ml-auto flex flex-col items-start gap-2">
                        <div className="flex items-baseline gap-2">
                            <span className="text-xs text-muted-foreground">{t('lastScan')}</span>
                            <span className="text-sm font-medium">{formatRelativeTime(lastScanFinishedAt, tTime, now)}</span>
                        </div>
                        <ScanAllButton scanning={anyInFlight} />
                    </div>
                </CardContent>
            </Card>
            {pendingTotal > 0 ? (
                <Card>
                    <CardHeader>
                        <CardTitle>{t('severityBreakdown')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-wrap gap-2">
                            <SeverityPill variant="critical" count={c.critical} />
                            <SeverityPill variant="high" count={c.high} />
                            <SeverityPill variant="moderate" count={c.moderate} />
                            <SeverityPill variant="low" count={c.low} />
                            <SeverityPill variant="info" count={c.info} />
                        </div>
                    </CardContent>
                </Card>
            ) : null}
        </div>
    )
}
