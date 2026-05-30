'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { CurrentFindingRow } from '@sentinello/db'
import type { Mute, Severity } from '@sentinello/core'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MuteDialog } from '@/components/triage/mute-dialog'
import { formatAbsoluteTime, formatRelativeTime, parseJsonArray } from '@/lib/format'
import { cn } from '@/lib/cn'
import { VersionChain } from './version-chain'
import { DepPathCell } from './dep-path-cell'

type Props = {
    findings: CurrentFindingRow[]
    projectId: string
    mutes: Mute[]
    now: number
}

export function FindingsTable({ findings, projectId, mutes, now }: Props) {
    const t = useTranslations('Findings')
    const tTime = useTranslations('Time')
    return (
        <>
            <div className="space-y-2 md:hidden">
                {findings.map(function card(f) {
                    const depPath = parseJsonArray(f.depPathJson)
                    const findingMute = findMatchingMute(mutes, projectId, f)
                    return (
                        <Card key={f.id} className={cn('p-4', f.isMuted && 'opacity-60')}>
                            <div className="flex flex-wrap items-center gap-2">
                                <SeverityPill variant={f.severity as Severity} size="sm" />
                                <span className="min-w-0 flex-1 truncate font-medium text-sm">
                                    {f.packageName}
                                </span>
                                {f.isDev && !f.isProd ? <Badge variant="dev">{t('dev')}</Badge> : null}
                                <SourceBadges scanner={f.scanner} advisoryId={f.advisoryId} t={t} />
                            </div>
                            <dl className="mt-3 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 text-xs">
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.version')}</dt>
                                <dd>
                                    <VersionChain
                                        installed={f.installedVersion}
                                        fix={f.fixVersion}
                                        vulnerableRange={f.vulnerableRange}
                                        fixAvailable={f.fixAvailable}
                                    />
                                </dd>
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.advisory')}</dt>
                                <dd className="min-w-0 break-words">
                                    {(f.advisoryUrl && (
                                        <Link href={f.advisoryUrl} target="_blank" className="hover:opacity-80">
                                            {f.advisoryTitle || f.advisoryId}
                                        </Link>
                                    )) || <span>{f.advisoryTitle || f.advisoryId}</span>}
                                </dd>
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.depPath')}</dt>
                                <dd className="min-w-0">
                                    <DepPathCell path={depPath} />
                                </dd>
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.detected')}</dt>
                                <dd className="font-mono" title={formatAbsoluteTime(f.firstDetectedAt)}>
                                    {formatRelativeTime(f.firstDetectedAt, tTime, now)}
                                </dd>
                            </dl>
                            <div className="mt-3 flex justify-end border-t border-border/40 pt-3">
                                {(findingMute && (
                                    <MuteDialog
                                        projectId={projectId}
                                        muteId={findingMute.id}
                                        finding={{ scanner: f.scanner, advisoryId: f.advisoryId, packageName: f.packageName }}
                                    />
                                )) || (
                                    <MuteDialog
                                        projectId={projectId}
                                        finding={{ scanner: f.scanner, advisoryId: f.advisoryId, packageName: f.packageName }}
                                    />
                                )}
                            </div>
                        </Card>
                    )
                })}
            </div>
            <div className="hidden md:block">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t('columns.sev')}</TableHead>
                            <TableHead>{t('columns.package')}</TableHead>
                            <TableHead>{t('columns.version')}</TableHead>
                            <TableHead>{t('columns.advisory')}</TableHead>
                            <TableHead>{t('columns.depPath')}</TableHead>
                            <TableHead>{t('columns.detected')}</TableHead>
                            <TableHead className="text-right">{t('columns.triage')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {findings.map(function row(f) {
                            const depPath = parseJsonArray(f.depPathJson)
                            const findingMute = findMatchingMute(mutes, projectId, f)
                            return (
                                <TableRow key={f.id} className={f.isMuted ? 'opacity-60' : ''}>
                                    <TableCell>
                                        <SeverityPill variant={f.severity as Severity} size="sm" />
                                    </TableCell>
                                    <TableCell className="font-medium">
                                        <span>{f.packageName}</span>
                                        {f.isDev && !f.isProd ? (
                                            <Badge variant="dev" className="ml-2">{t('dev')}</Badge>
                                        ) : null}
                                        <SourceBadges scanner={f.scanner} advisoryId={f.advisoryId} t={t} className="ml-2" />
                                    </TableCell>
                                    <TableCell>
                                        <VersionChain
                                            installed={f.installedVersion}
                                            fix={f.fixVersion}
                                            vulnerableRange={f.vulnerableRange}
                                            fixAvailable={f.fixAvailable}
                                        />
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {f.advisoryUrl ? (
                                            <Link href={f.advisoryUrl} target="_blank" className="hover:opacity-80">
                                                {f.advisoryTitle || f.advisoryId}
                                            </Link>
                                        ) : (
                                            <span>{f.advisoryTitle || f.advisoryId}</span>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <DepPathCell path={depPath} />
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        <span title={formatAbsoluteTime(f.firstDetectedAt)}>
                                            {formatRelativeTime(f.firstDetectedAt, tTime, now)}
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        {findingMute ? (
                                            <MuteDialog
                                                projectId={projectId}
                                                muteId={findingMute.id}
                                                finding={{ scanner: f.scanner, advisoryId: f.advisoryId, packageName: f.packageName }}
                                                iconOnly
                                            />
                                        ) : (
                                            <MuteDialog
                                                projectId={projectId}
                                                finding={{ scanner: f.scanner, advisoryId: f.advisoryId, packageName: f.packageName }}
                                                iconOnly
                                            />
                                        )}
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

type SourceBadgesProps = {
    scanner: string
    advisoryId: string
    t: (key: string) => string
    className?: string
}

// Renders the provenance of a finding: a "malicious package" emphasis badge for OSV MAL- records (a
// distinct threat class), plus a small source badge (OSV vs npm) so operators can tell where a finding
// came from once multiple sources are enabled. Malicious is detected by the MAL- advisory-id prefix —
// no extra column needed since the OSV scanner stores those ids verbatim.
function SourceBadges({ scanner, advisoryId, t, className }: SourceBadgesProps) {
    const isMalicious = advisoryId.startsWith('MAL-')
    const isOsv = scanner === 'osv'
    if (!isMalicious && !isOsv) return null
    return (
        <>
            {isMalicious ? (
                <Badge variant="malicious" className={className}>{t('malicious')}</Badge>
            ) : null}
            {isOsv ? (
                <Badge variant="osv" className={className}>OSV</Badge>
            ) : null}
        </>
    )
}

function findMatchingMute(mutes: Mute[], projectId: string, f: CurrentFindingRow): Mute | undefined {
    return mutes.find(function find(m): boolean {
        return (
            m.scope === 'finding' &&
            (m.projectId === null || m.projectId === projectId) &&
            m.scanner === f.scanner &&
            m.advisoryId === f.advisoryId &&
            m.packageName === f.packageName
        )
    })
}
