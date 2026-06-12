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

type ProjectGroup = {
    projectId: string
    projectName: string
    devOnly: boolean
    installedVersions: string[]
    maxSeverity: Severity
    usages: LibraryProjectUsage[]
}

function groupByProject(usages: LibraryProjectUsage[]): ProjectGroup[] {
    const byProject = new Map<string, LibraryProjectUsage[]>()
    for (const u of usages) {
        const bucket = byProject.get(u.projectId) || []
        bucket.push(u)
        byProject.set(u.projectId, bucket)
    }
    const groups: ProjectGroup[] = []
    byProject.forEach(function build(rows) {
        const head = rows[0]
        const devOnly = rows.every(function isDevOnly(r) { return r.isDev && !r.isProd })
        const installedVersions = Array.from(new Set(rows.map(function pickVer(r) { return r.installedVersion })))
        let maxSev: Severity = rows[0].severity as Severity
        for (const r of rows) {
            if (severityRank(r.severity) < severityRank(maxSev)) {
                maxSev = r.severity as Severity
            }
        }
        groups.push({
            projectId: head.projectId,
            projectName: head.projectName,
            devOnly,
            installedVersions,
            maxSeverity: maxSev,
            usages: rows
        })
    })
    groups.sort(function order(a, b) { return a.projectName.localeCompare(b.projectName) })
    return groups
}

export function LibraryByProjectTable({ packageName, usages, activeMutes, now }: Props) {
    const t = useTranslations('Findings')
    const groups = useMemo(function build() { return groupByProject(usages) }, [usages])
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    function toggle(projectId: string) {
        const next = new Set(expanded)
        if (next.has(projectId)) {
            next.delete(projectId)
        } else {
            next.add(projectId)
        }
        setExpanded(next)
    }
    return (
        <>
            <div className="space-y-2 md:hidden">
                {groups.map(function card(group) {
                    return (
                        <ProjectCard
                            key={group.projectId}
                            packageName={packageName}
                            group={group}
                            activeMutes={activeMutes}
                            isOpen={expanded.has(group.projectId)}
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
                            <TableHead>{t('columns.project')}</TableHead>
                            <TableHead>{t('columns.installed')}</TableHead>
                            <TableHead className="text-right">{t('columns.advisories')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {groups.map(function renderGroup(group) {
                            const isOpen = expanded.has(group.projectId)
                            return (
                                <ProjectRows
                                    key={group.projectId}
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
    group: ProjectGroup
    activeMutes: Mute[]
    isOpen: boolean
    onToggle: (projectId: string) => void
    now: number
}

function ProjectRows({ packageName, group, activeMutes, isOpen, onToggle, now }: RowProps) {
    const t = useTranslations('Findings')
    return (
        <>
            <TableRow className="cursor-pointer">
                <TableCell onClick={function flip() { onToggle(group.projectId) }} className="w-8 text-muted-foreground">
                    {(isOpen && <ChevronDown className="h-4 w-4" />) || <ChevronRight className="h-4 w-4" />}
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.projectId) }}>
                    <SeverityPill variant={group.maxSeverity} size="sm" />
                </TableCell>
                <TableCell className="font-medium">
                    <Link href={'/projects/' + group.projectId} className="hover:opacity-80" onClick={function stop(e) { e.stopPropagation() }}>
                        {group.projectName}
                    </Link>
                    {group.devOnly ? <Badge variant="dev" className="ml-2">{t('dev')}</Badge> : null}
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.projectId) }} className="font-mono text-xs">
                    {group.installedVersions.join(', ')}
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.projectId) }} className="text-right text-xs font-mono">
                    {group.usages.length}
                </TableCell>
            </TableRow>
            {isOpen ? (
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={5} className="px-3 py-3">
                        <ExpandedAdvisories packageName={packageName} group={group} activeMutes={activeMutes} now={now} />
                    </TableCell>
                </TableRow>
            ) : null}
        </>
    )
}

function ProjectCard({ packageName, group, activeMutes, isOpen, onToggle, now }: RowProps) {
    const t = useTranslations('Findings')
    const tTime = useTranslations('Time')
    const sortedUsages = useMemo(function sort() {
        const copy = group.usages.slice()
        copy.sort(function order(a, b) {
            const ra = severityRank(a.severity)
            const rb = severityRank(b.severity)
            if (ra !== rb) return ra - rb
            return a.advisoryId.localeCompare(b.advisoryId)
        })
        return copy
    }, [group.usages])
    return (
        <Card className="overflow-hidden p-0">
            <div
                onClick={function flip() { onToggle(group.projectId) }}
                className="flex cursor-pointer items-start gap-2 p-4"
            >
                <span className="mt-0.5 text-muted-foreground">
                    {(isOpen && <ChevronDown className="h-4 w-4" />) || <ChevronRight className="h-4 w-4" />}
                </span>
                <SeverityPill variant={group.maxSeverity} size="sm" />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <Link
                            href={'/projects/' + group.projectId}
                            className="min-w-0 flex-1 truncate font-medium text-sm hover:opacity-80"
                            onClick={function stop(e) { e.stopPropagation() }}
                        >
                            {group.projectName}
                        </Link>
                        {group.devOnly ? <Badge variant="dev">{t('dev')}</Badge> : null}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                        <span className="font-mono">{group.installedVersions.join(', ')}</span>
                        <span> · {t('advisoriesCount', { count: group.usages.length })}</span>
                    </div>
                </div>
            </div>
            {isOpen ? (
                <div className="space-y-2 border-t border-border/40 bg-muted/30 px-4 py-3">
                    {sortedUsages.map(function adv(u) {
                        const findingMute = activeMutes.find(function find(m): boolean {
                            return (
                                m.scope === 'finding' &&
                                (m.projectId === null || m.projectId === group.projectId) &&
                                m.scanner === u.source &&
                                (m.ecosystem === null || m.ecosystem === u.ecosystem) &&
                                m.advisoryId === u.advisoryId &&
                                m.packageName === packageName
                            )
                        })
                        return (
                            <div
                                key={u.advisoryId}
                                className={cn(
                                    'rounded-md border bg-card p-3 text-xs',
                                    findingMute && 'opacity-60'
                                )}
                            >
                                <div className="flex items-center gap-2">
                                    <SeverityPill variant={u.severity as Severity} size="sm" />
                                    <div className="min-w-0 flex-1 break-words">
                                        {(u.advisoryUrl && (
                                            <Link
                                                href={u.advisoryUrl}
                                                target="_blank"
                                                className="inline-flex items-center gap-1 hover:opacity-80"
                                            >
                                                <span>{u.advisoryTitle || u.advisoryId}</span>
                                                <ExternalLink className="h-3 w-3" />
                                            </Link>
                                        )) || <span>{u.advisoryTitle || u.advisoryId}</span>}
                                    </div>
                                </div>
                                <div className="mt-2 font-mono text-muted-foreground">
                                    {t('rangeLabel')} {u.vulnerableRange}
                                </div>
                                <div className="mt-1 font-mono text-muted-foreground" title={formatAbsoluteTime(u.firstDetectedAt)}>
                                    {t('detectedLabel')} {formatRelativeTime(u.firstDetectedAt, tTime, now)}
                                </div>
                                <div className="mt-2 flex justify-end">
                                    {(findingMute && (
                                        <MuteDialog
                                            projectId={group.projectId}
                                            muteId={findingMute.id}
                                            finding={{ source: u.source, ecosystem: u.ecosystem, scanner: u.scanner, advisoryId: u.advisoryId, packageName }}
                                        />
                                    )) || (
                                        <MuteDialog
                                            projectId={group.projectId}
                                            finding={{ source: u.source, ecosystem: u.ecosystem, scanner: u.scanner, advisoryId: u.advisoryId, packageName }}
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
    group: ProjectGroup
    activeMutes: Mute[]
    now: number
}

function ExpandedAdvisories({ packageName, group, activeMutes, now }: ExpandedProps) {
    const t = useTranslations('Findings')
    const tTime = useTranslations('Time')
    const projectId = group.projectId
    const sorted = useMemo(function sort() {
        const copy = group.usages.slice()
        copy.sort(function order(a, b) {
            const ra = severityRank(a.severity)
            const rb = severityRank(b.severity)
            if (ra !== rb) return ra - rb
            return a.advisoryId.localeCompare(b.advisoryId)
        })
        return copy
    }, [group.usages])
    return (
        <div>
            <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                    <tr className="border-b">
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.sev')}</th>
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.advisory')}</th>
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.vulnerableRange')}</th>
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.detected')}</th>
                        <th className="px-2 py-1.5 text-right font-medium uppercase tracking-wide">{t('columns.triage')}</th>
                    </tr>
                </thead>
                <tbody>
                    {sorted.map(function row(u) {
                        const findingMute = activeMutes.find(function find(m): boolean {
                            return (
                                m.scope === 'finding' &&
                                (m.projectId === null || m.projectId === projectId) &&
                                m.scanner === u.source &&
                                (m.ecosystem === null || m.ecosystem === u.ecosystem) &&
                                m.advisoryId === u.advisoryId &&
                                m.packageName === packageName
                            )
                        })
                        return (
                            <tr key={u.advisoryId} className={cn('border-b last:border-0', findingMute && 'opacity-60')}>
                                <td className="px-2 py-1.5 align-middle">
                                    <SeverityPill variant={u.severity as Severity} size="sm" />
                                </td>
                                <td className="px-2 py-1.5 align-middle">
                                    {(u.advisoryUrl && (
                                        <Link
                                            href={u.advisoryUrl}
                                            target="_blank"
                                            className="inline-flex items-center gap-1 hover:opacity-80"
                                        >
                                            <span>{u.advisoryTitle || u.advisoryId}</span>
                                            <ExternalLink className="h-3 w-3" />
                                        </Link>
                                    )) || <span>{u.advisoryTitle || u.advisoryId}</span>}
                                </td>
                                <td className="px-2 py-1.5 align-middle font-mono text-muted-foreground">
                                    {u.vulnerableRange}
                                </td>
                                <td className="px-2 py-1.5 align-middle font-mono text-muted-foreground" title={formatAbsoluteTime(u.firstDetectedAt)}>
                                    {formatRelativeTime(u.firstDetectedAt, tTime, now)}
                                </td>
                                <td className="px-2 py-1.5 align-middle text-right">
                                    {(findingMute && (
                                        <MuteDialog
                                            projectId={projectId}
                                            muteId={findingMute.id}
                                            finding={{ source: u.source, ecosystem: u.ecosystem, scanner: u.scanner, advisoryId: u.advisoryId, packageName }}
                                            iconOnly
                                        />
                                    )) || (
                                        <MuteDialog
                                            projectId={projectId}
                                            finding={{ source: u.source, ecosystem: u.ecosystem, scanner: u.scanner, advisoryId: u.advisoryId, packageName }}
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
