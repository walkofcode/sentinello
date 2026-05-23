'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react'
import type { LibraryProjectUsage } from '@sentinello/db'
import { severityRank, type Mute, type Severity } from '@sentinello/core'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MuteDialog } from '@/components/triage/mute-dialog'
import { cn } from '@/lib/cn'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'

type Props = {
    packageName: string
    usages: LibraryProjectUsage[]
    activeMutes: Mute[]
    now: number
}

type AdvisoryGroup = {
    advisoryId: string
    advisoryTitle: string | null
    advisoryUrl: string | null
    severity: Severity
    vulnerableRange: string
    usages: LibraryProjectUsage[]
}

function groupByAdvisory(usages: LibraryProjectUsage[]): AdvisoryGroup[] {
    const byAdvisory = new Map<string, LibraryProjectUsage[]>()
    for (const u of usages) {
        const bucket = byAdvisory.get(u.advisoryId) || []
        bucket.push(u)
        byAdvisory.set(u.advisoryId, bucket)
    }
    const groups: AdvisoryGroup[] = []
    byAdvisory.forEach(function build(rows, advisoryId) {
        const head = rows[0]
        groups.push({
            advisoryId,
            advisoryTitle: head.advisoryTitle,
            advisoryUrl: head.advisoryUrl,
            severity: head.severity as Severity,
            vulnerableRange: head.vulnerableRange,
            usages: rows
        })
    })
    groups.sort(function order(a, b) {
        const ra = severityRank(a.severity)
        const rb = severityRank(b.severity)
        if (ra !== rb) return ra - rb
        return a.advisoryId.localeCompare(b.advisoryId)
    })
    return groups
}

export function LibraryByAdvisoryTable({ packageName, usages, activeMutes, now }: Props) {
    const t = useTranslations('Findings')
    const groups = useMemo(function build() { return groupByAdvisory(usages) }, [usages])
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    function toggle(advisoryId: string) {
        const next = new Set(expanded)
        if (next.has(advisoryId)) {
            next.delete(advisoryId)
        } else {
            next.add(advisoryId)
        }
        setExpanded(next)
    }
    return (
        <>
            <div className="space-y-2 md:hidden">
                {groups.map(function card(group) {
                    return (
                        <AdvisoryCard
                            key={group.advisoryId}
                            packageName={packageName}
                            group={group}
                            activeMutes={activeMutes}
                            isOpen={expanded.has(group.advisoryId)}
                            onToggle={toggle}
                            now={now}
                        />
                    )
                })}
            </div>
            <div className="hidden md:block">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-8"></TableHead>
                            <TableHead>{t('columns.sev')}</TableHead>
                            <TableHead>{t('columns.advisory')}</TableHead>
                            <TableHead>{t('columns.vulnerableRange')}</TableHead>
                            <TableHead className="text-right">{t('columns.projects')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {groups.map(function renderGroup(group) {
                            const isOpen = expanded.has(group.advisoryId)
                            return (
                                <AdvisoryRows
                                    key={group.advisoryId}
                                    packageName={packageName}
                                    group={group}
                                    activeMutes={activeMutes}
                                    isOpen={isOpen}
                                    onToggle={toggle}
                                    now={now}
                                />
                            )
                        })}
                    </TableBody>
                </Table>
            </div>
        </>
    )
}

type RowProps = {
    packageName: string
    group: AdvisoryGroup
    activeMutes: Mute[]
    isOpen: boolean
    onToggle: (advisoryId: string) => void
    now: number
}

function AdvisoryRows({ packageName, group, activeMutes, isOpen, onToggle, now }: RowProps) {
    return (
        <>
            <TableRow className="cursor-pointer">
                <TableCell onClick={function flip() { onToggle(group.advisoryId) }} className="w-8 text-muted-foreground">
                    {(isOpen && <ChevronDown className="h-4 w-4" />) || <ChevronRight className="h-4 w-4" />}
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.advisoryId) }}>
                    <SeverityPill variant={group.severity} size="sm" />
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.advisoryId) }} className="text-xs">
                    {(group.advisoryUrl && (
                        <Link
                            href={group.advisoryUrl}
                            target="_blank"
                            className="inline-flex items-center gap-1 hover:opacity-80"
                            onClick={function stop(e) { e.stopPropagation() }}
                        >
                            <span>{group.advisoryTitle || group.advisoryId}</span>
                            <ExternalLink className="h-3 w-3" />
                        </Link>
                    )) || <span>{group.advisoryTitle || group.advisoryId}</span>}
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.advisoryId) }} className="font-mono text-xs text-muted-foreground">
                    {group.vulnerableRange}
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.advisoryId) }} className="text-right text-xs font-mono">
                    {group.usages.length}
                </TableCell>
            </TableRow>
            {isOpen ? (
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={5} className="px-3 py-3">
                        <ExpandedProjects packageName={packageName} group={group} activeMutes={activeMutes} now={now} />
                    </TableCell>
                </TableRow>
            ) : null}
        </>
    )
}

function AdvisoryCard({ packageName, group, activeMutes, isOpen, onToggle, now }: RowProps) {
    const t = useTranslations('Findings')
    const tTime = useTranslations('Time')
    const sortedUsages = useMemo(function sort() {
        const copy = group.usages.slice()
        copy.sort(function order(a, b) { return a.projectName.localeCompare(b.projectName) })
        return copy
    }, [group.usages])
    return (
        <Card className="overflow-hidden p-0">
            <div
                onClick={function flip() { onToggle(group.advisoryId) }}
                className="flex cursor-pointer items-start gap-2 p-4"
            >
                <span className="mt-0.5 text-muted-foreground">
                    {(isOpen && <ChevronDown className="h-4 w-4" />) || <ChevronRight className="h-4 w-4" />}
                </span>
                <SeverityPill variant={group.severity} size="sm" />
                <div className="min-w-0 flex-1">
                    <div className="min-w-0 break-words text-sm font-medium">
                        {(group.advisoryUrl && (
                            <Link
                                href={group.advisoryUrl}
                                target="_blank"
                                className="inline-flex items-center gap-1 hover:opacity-80"
                                onClick={function stop(e) { e.stopPropagation() }}
                            >
                                <span>{group.advisoryTitle || group.advisoryId}</span>
                                <ExternalLink className="h-3 w-3" />
                            </Link>
                        )) || <span>{group.advisoryTitle || group.advisoryId}</span>}
                    </div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">
                        {group.vulnerableRange}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                        {t('projectsAffected', { count: group.usages.length })}
                    </div>
                </div>
            </div>
            {isOpen ? (
                <div className="space-y-2 border-t border-border/40 bg-muted/30 px-4 py-3">
                    {sortedUsages.map(function proj(u) {
                        const findingMute = activeMutes.find(function find(m): boolean {
                            return (
                                m.scope === 'finding' &&
                                (m.projectId === null || m.projectId === u.projectId) &&
                                m.scanner === u.scanner &&
                                m.advisoryId === group.advisoryId &&
                                m.packageName === packageName
                            )
                        })
                        return (
                            <div
                                key={u.projectId}
                                className={cn(
                                    'rounded-md border bg-card p-3 text-xs',
                                    findingMute && 'opacity-60'
                                )}
                            >
                                <div className="flex items-center gap-2">
                                    <Link
                                        href={'/projects/' + u.projectId}
                                        className="min-w-0 flex-1 truncate font-medium hover:opacity-80"
                                    >
                                        {u.projectName}
                                    </Link>
                                    {(u.isDev && !u.isProd && <Badge variant="dev">{t('dev')}</Badge>) || null}
                                </div>
                                <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1">
                                    <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.installed')}</dt>
                                    <dd className="font-mono">{u.installedVersion}</dd>
                                    <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.scope')}</dt>
                                    <dd className="text-muted-foreground">{u.isDev && !u.isProd ? t('dev') : t('prod')}</dd>
                                    <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.detected')}</dt>
                                    <dd className="font-mono text-muted-foreground" title={formatAbsoluteTime(u.firstDetectedAt)}>
                                        {formatRelativeTime(u.firstDetectedAt, tTime, now)}
                                    </dd>
                                </dl>
                                <div className="mt-2 flex justify-end">
                                    {(findingMute && (
                                        <MuteDialog
                                            projectId={u.projectId}
                                            muteId={findingMute.id}
                                            finding={{ scanner: u.scanner, advisoryId: group.advisoryId, packageName }}
                                        />
                                    )) || (
                                        <MuteDialog
                                            projectId={u.projectId}
                                            finding={{ scanner: u.scanner, advisoryId: group.advisoryId, packageName }}
                                        />
                                    )}
                                </div>
                            </div>
                        )
                    })}
                </div>
            ) : null}
        </Card>
    )
}

type ExpandedProps = {
    packageName: string
    group: AdvisoryGroup
    activeMutes: Mute[]
    now: number
}

function ExpandedProjects({ packageName, group, activeMutes, now }: ExpandedProps) {
    const t = useTranslations('Findings')
    const tTime = useTranslations('Time')
    const advisoryId = group.advisoryId
    const sortedUsages = useMemo(function sort() {
        const copy = group.usages.slice()
        copy.sort(function order(a, b) { return a.projectName.localeCompare(b.projectName) })
        return copy
    }, [group.usages])
    return (
        <div>
            <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                    <tr className="border-b">
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.project')}</th>
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.installed')}</th>
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.scope')}</th>
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.detected')}</th>
                        <th className="px-2 py-1.5 text-right font-medium uppercase tracking-wide">{t('columns.triage')}</th>
                    </tr>
                </thead>
                <tbody>
                    {sortedUsages.map(function row(u) {
                        const findingMute = activeMutes.find(function find(m): boolean {
                            return (
                                m.scope === 'finding' &&
                                (m.projectId === null || m.projectId === u.projectId) &&
                                m.scanner === u.scanner &&
                                m.advisoryId === advisoryId &&
                                m.packageName === packageName
                            )
                        })
                        return (
                            <tr key={u.projectId + '|' + advisoryId} className={cn('border-b last:border-0', findingMute && 'opacity-60')}>
                                <td className="px-2 py-1.5 align-middle">
                                    <Link href={'/projects/' + u.projectId} className="hover:opacity-80">
                                        {u.projectName}
                                    </Link>
                                </td>
                                <td className="px-2 py-1.5 align-middle font-mono">
                                    {u.installedVersion}
                                </td>
                                <td className="px-2 py-1.5 align-middle">
                                    {(u.isDev && !u.isProd && <Badge variant="dev">{t('dev')}</Badge>) || <span className="text-muted-foreground">{t('prod')}</span>}
                                </td>
                                <td className="px-2 py-1.5 align-middle font-mono text-muted-foreground" title={formatAbsoluteTime(u.firstDetectedAt)}>
                                    {formatRelativeTime(u.firstDetectedAt, tTime, now)}
                                </td>
                                <td className="px-2 py-1.5 align-middle text-right">
                                    {(findingMute && (
                                        <MuteDialog
                                            projectId={u.projectId}
                                            muteId={findingMute.id}
                                            finding={{ scanner: u.scanner, advisoryId, packageName }}
                                            iconOnly
                                        />
                                    )) || (
                                        <MuteDialog
                                            projectId={u.projectId}
                                            finding={{ scanner: u.scanner, advisoryId, packageName }}
                                            iconOnly
                                        />
                                    )}
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}
