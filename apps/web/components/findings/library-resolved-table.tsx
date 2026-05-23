import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { ExternalLink } from 'lucide-react'
import type { ResolvedLibraryFinding } from '@sentinello/db'
import { type Severity } from '@sentinello/core'
import { Card } from '@/components/ui/card'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAbsoluteTime, formatExposureWindow, formatRelativeTime } from '@/lib/format'

type Props = {
    findings: ResolvedLibraryFinding[]
    now: number
}

export async function LibraryResolvedTable({ findings, now }: Props) {
    const t = await getTranslations('Findings')
    const tTime = await getTranslations('Time')
    return (
        <>
            <div className="space-y-2 md:hidden">
                {findings.map(function card(f) {
                    const exposureMs = f.resolvedAt && f.firstDetectedAt ? f.resolvedAt - f.firstDetectedAt : null
                    return (
                        <Card key={f.id} className="p-4">
                            <div className="flex items-center gap-2">
                                <SeverityPill variant={f.severity as Severity} size="sm" />
                                <Link
                                    href={'/projects/' + f.projectId}
                                    className="min-w-0 flex-1 truncate font-medium text-sm hover:opacity-80"
                                >
                                    {f.projectName}
                                </Link>
                            </div>
                            <dl className="mt-3 grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-xs">
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.advisory')}</dt>
                                <dd className="min-w-0 break-words">
                                    {(f.advisoryUrl && (
                                        <Link
                                            href={f.advisoryUrl}
                                            target="_blank"
                                            className="inline-flex items-center gap-1 hover:opacity-80"
                                        >
                                            <span>{f.advisoryTitle || f.advisoryId}</span>
                                            <ExternalLink className="h-3 w-3" />
                                        </Link>
                                    )) || <span>{f.advisoryTitle || f.advisoryId}</span>}
                                </dd>
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.firstDetected')}</dt>
                                <dd className="font-mono" title={formatAbsoluteTime(f.firstDetectedAt)}>
                                    {formatRelativeTime(f.firstDetectedAt, tTime, now)}
                                </dd>
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.resolved')}</dt>
                                <dd className="font-mono" title={formatAbsoluteTime(f.resolvedAt)}>
                                    {formatRelativeTime(f.resolvedAt, tTime, now)}
                                </dd>
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.exposure')}</dt>
                                <dd className="font-mono text-muted-foreground">
                                    {formatExposureWindow(exposureMs, tTime)}
                                </dd>
                            </dl>
                        </Card>
                    )
                })}
            </div>
            <div className="hidden md:block">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t('columns.sev')}</TableHead>
                            <TableHead>{t('columns.project')}</TableHead>
                            <TableHead>{t('columns.advisory')}</TableHead>
                            <TableHead>{t('columns.firstDetected')}</TableHead>
                            <TableHead>{t('columns.resolved')}</TableHead>
                            <TableHead className="text-right">{t('columns.exposure')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {findings.map(function row(f) {
                            const exposureMs = f.resolvedAt && f.firstDetectedAt ? f.resolvedAt - f.firstDetectedAt : null
                            return (
                                <TableRow key={f.id}>
                                    <TableCell>
                                        <SeverityPill variant={f.severity as Severity} size="sm" />
                                    </TableCell>
                                    <TableCell className="font-medium">
                                        <Link href={'/projects/' + f.projectId} className="hover:opacity-80">
                                            {f.projectName}
                                        </Link>
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {f.advisoryUrl ? (
                                            <Link href={f.advisoryUrl} target="_blank" className="inline-flex items-center gap-1 hover:opacity-80">
                                                <span>{f.advisoryTitle || f.advisoryId}</span>
                                                <ExternalLink className="h-3 w-3" />
                                            </Link>
                                        ) : (
                                            <span>{f.advisoryTitle || f.advisoryId}</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        <span title={formatAbsoluteTime(f.firstDetectedAt)}>
                                            {formatRelativeTime(f.firstDetectedAt, tTime, now)}
                                        </span>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        <span title={formatAbsoluteTime(f.resolvedAt)}>
                                            {formatRelativeTime(f.resolvedAt, tTime, now)}
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                                        {formatExposureWindow(exposureMs, tTime)}
                                    </TableCell>
                                </TableRow>
                            )
                        })}
                    </TableBody>
                </Table>
            </div>
        </>
    )
}
