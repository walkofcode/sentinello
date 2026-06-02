'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { CurrentFindingRow } from '@sentinello/db'
import type { Mute, Severity } from '@sentinello/core'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MuteDialog } from '@/components/triage/mute-dialog'
import { MuteLibraryButton } from '@/components/triage/mute-library-button'
import { cn } from '@/lib/cn'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { groupByLibrary, type LibraryGroup } from './group-by-library'
import { VersionChain } from './version-chain'
import { SourceTags } from './source-tags'

type Props = {
    findings: CurrentFindingRow[]
    projectId: string
    mutes: Mute[]
    now: number
}

export function LibrariesTable({ findings, projectId, mutes, now }: Props) {
    const t = useTranslations('Findings')
    const groups = useMemo(function build() { return groupByLibrary(findings) }, [findings])
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    function toggle(packageName: string) {
        const next = new Set(expanded)
        if (next.has(packageName)) {
            next.delete(packageName)
        } else {
            next.add(packageName)
        }
        setExpanded(next)
    }
    return (
        <>
            <div className="space-y-2 md:hidden">
                {groups.map(function card(group) {
                    return (
                        <LibraryCard
                            key={group.packageName}
                            group={group}
                            projectId={projectId}
                            mutes={mutes}
                            isOpen={expanded.has(group.packageName)}
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
                            <TableHead>{t('columns.library')}</TableHead>
                            <TableHead>{t('columns.advisories')}</TableHead>
                            <TableHead>{t('columns.recommendedUpgrade')}</TableHead>
                            <TableHead className="text-right">{t('columns.triage')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {groups.map(function renderGroup(group) {
                            const isOpen = expanded.has(group.packageName)
                            return (
                                <LibraryRows
                                    key={group.packageName}
                                    group={group}
                                    projectId={projectId}
                                    mutes={mutes}
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
    group: LibraryGroup
    projectId: string
    mutes: Mute[]
    isOpen: boolean
    onToggle: (packageName: string) => void
    now: number
}

function LibraryRows({ group, projectId, mutes, isOpen, onToggle, now }: RowProps) {
    const t = useTranslations('Findings')
    const unmutedAdvisories = group.findings
        .filter(function notMuted(f) { return !f.isMuted })
        .map(function toAdv(f) { return { scanner: f.scanner, advisoryId: f.advisoryId } })
    return (
        <>
            <TableRow className={cn('cursor-pointer', group.allMuted && 'opacity-60')}>
                <TableCell onClick={function flip() { onToggle(group.packageName) }} className="w-8 text-muted-foreground">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.packageName) }}>
                    <SeverityPill variant={group.maxSeverity as Severity} size="sm" />
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.packageName) }} className="font-medium">
                    <span>{group.packageName}</span>
                    {group.devOnly ? <Badge variant="dev" className="ml-2">{t('dev')}</Badge> : null}
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.packageName) }} className="text-xs">
                    <span className="font-mono">{group.advisoryCount}</span>
                    {group.partial ? (
                        <span className="ml-2 text-muted-foreground">
                            ({t('fixableCount', { fixed: group.fixedCount, total: group.advisoryCount })})
                        </span>
                    ) : null}
                </TableCell>
                <TableCell onClick={function flip() { onToggle(group.packageName) }} className="text-xs">
                    {group.recommendedUpgrade ? (
                        <Badge variant="default" className="font-mono">{'>= ' + group.recommendedUpgrade}</Badge>
                    ) : (
                        <span className="text-muted-foreground">{t('noPatchPublished')}</span>
                    )}
                </TableCell>
                <TableCell className="text-right">
                    <MuteLibraryButton
                        projectId={projectId}
                        packageName={group.packageName}
                        advisories={unmutedAdvisories}
                        unmutedCount={unmutedAdvisories.length}
                    />
                </TableCell>
            </TableRow>
            {isOpen ? (
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={6} className="px-3 py-3">
                        <ExpandedAdvisories group={group} projectId={projectId} mutes={mutes} now={now} />
                    </TableCell>
                </TableRow>
            ) : null}
        </>
    )
}

function LibraryCard({ group, projectId, mutes, isOpen, onToggle, now }: RowProps) {
    const t = useTranslations('Findings')
    const tTime = useTranslations('Time')
    const unmutedAdvisories = group.findings
        .filter(function notMuted(f) { return !f.isMuted })
        .map(function toAdv(f) { return { scanner: f.scanner, advisoryId: f.advisoryId } })
    return (
        <Card className={cn('overflow-hidden p-0', group.allMuted && 'opacity-60')}>
            <div
                onClick={function flip() { onToggle(group.packageName) }}
                className="flex cursor-pointer items-start gap-2 p-4"
            >
                <span className="mt-0.5 text-muted-foreground">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
                <SeverityPill variant={group.maxSeverity as Severity} size="sm" />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium text-sm">{group.packageName}</span>
                        {group.devOnly ? <Badge variant="dev">{t('dev')}</Badge> : null}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                        <span className="font-mono">{group.advisoryCount}</span>{' '}
                        <span>{t('advisoryCount', { count: group.advisoryCount })}</span>
                        {group.partial ? (
                            <span> · {t('fixableCount', { fixed: group.fixedCount, total: group.advisoryCount })}</span>
                        ) : null}
                    </div>
                    <div className="mt-2">
                        {group.recommendedUpgrade ? (
                            <Badge variant="default" className="font-mono">{'>= ' + group.recommendedUpgrade}</Badge>
                        ) : (
                            <span className="text-xs text-muted-foreground">{t('noPatchPublished')}</span>
                        )}
                    </div>
                </div>
            </div>
            {isOpen ? (
                <div className="space-y-2 border-t border-border/40 bg-muted/30 px-4 py-3">
                    {group.findings.map(function adv(f) {
                        const findingMute = mutes.find(function find(m): boolean {
                            return (
                                m.scope === 'finding' &&
                                (m.projectId === null || m.projectId === projectId) &&
                                m.scanner === f.scanner &&
                                m.advisoryId === f.advisoryId &&
                                m.packageName === f.packageName
                            )
                        })
                        return (
                            <div
                                key={f.id}
                                className={cn(
                                    'rounded-md border bg-card p-3 text-xs',
                                    f.isMuted && 'opacity-60'
                                )}
                            >
                                <div className="flex items-center gap-2">
                                    <SeverityPill variant={f.severity as Severity} size="sm" />
                                    <SourceTags scanners={[f.scanner]} />
                                    <div className="min-w-0 flex-1 break-words">
                                        {f.advisoryUrl ? (
                                            <Link href={f.advisoryUrl} target="_blank" className="hover:opacity-80">
                                                {f.advisoryTitle || f.advisoryId}
                                            </Link>
                                        ) : (
                                            <span>{f.advisoryTitle || f.advisoryId}</span>
                                        )}
                                    </div>
                                </div>
                                <div className="mt-2">
                                    <VersionChain
                                        installed={f.installedVersion}
                                        fix={f.fixVersion}
                                        vulnerableRange={f.vulnerableRange}
                                        fixAvailable={f.fixAvailable}
                                    />
                                </div>
                                <div className="mt-2 font-mono text-muted-foreground" title={formatAbsoluteTime(f.firstDetectedAt)}>
                                    {t('detectedLabel')} {formatRelativeTime(f.firstDetectedAt, tTime, now)}
                                </div>
                                <div className="mt-2 flex justify-end">
                                    {findingMute ? (
                                        <MuteDialog
                                            projectId={projectId}
                                            muteId={findingMute.id}
                                            finding={{ scanner: f.scanner, advisoryId: f.advisoryId, packageName: f.packageName }}
                                        />
                                    ) : (
                                        <MuteDialog
                                            projectId={projectId}
                                            finding={{ scanner: f.scanner, advisoryId: f.advisoryId, packageName: f.packageName }}
                                        />
                                    )}
                                </div>
                            </div>
                        )
                    })}
                </div>
            ) : null}
            <div className="flex justify-end border-t border-border/40 px-4 py-3">
                <MuteLibraryButton
                    projectId={projectId}
                    packageName={group.packageName}
                    advisories={unmutedAdvisories}
                    unmutedCount={unmutedAdvisories.length}
                />
            </div>
        </Card>
    )
}

function ExpandedAdvisories({ group, projectId, mutes, now }: { group: LibraryGroup; projectId: string; mutes: Mute[]; now: number }) {
    const t = useTranslations('Findings')
    const tTime = useTranslations('Time')
    return (
        <div>
            <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                    <tr className="border-b">
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.sev')}</th>
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.source')}</th>
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.advisory')}</th>
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.version')}</th>
                        <th className="px-2 py-1.5 text-left font-medium uppercase tracking-wide">{t('columns.detected')}</th>
                        <th className="px-2 py-1.5 text-right font-medium uppercase tracking-wide">{t('columns.triage')}</th>
                    </tr>
                </thead>
                <tbody>
                    {group.findings.map(function row(f) {
                        const findingMute = mutes.find(function find(m): boolean {
                            return (
                                m.scope === 'finding' &&
                                (m.projectId === null || m.projectId === projectId) &&
                                m.scanner === f.scanner &&
                                m.advisoryId === f.advisoryId &&
                                m.packageName === f.packageName
                            )
                        })
                        return (
                            <tr key={f.id} className={cn('border-b last:border-0', f.isMuted && 'opacity-60')}>
                                <td className="px-2 py-1.5 align-middle">
                                    <SeverityPill variant={f.severity as Severity} size="sm" />
                                </td>
                                <td className="px-2 py-1.5 align-middle">
                                    <span className="flex flex-wrap gap-1"><SourceTags scanners={[f.scanner]} /></span>
                                </td>
                                <td className="px-2 py-1.5 align-middle">
                                    {f.advisoryUrl ? (
                                        <Link
                                            href={f.advisoryUrl}
                                            target="_blank"
                                            className="hover:opacity-80"
                                        >
                                            {f.advisoryTitle || f.advisoryId}
                                        </Link>
                                    ) : (
                                        <span>{f.advisoryTitle || f.advisoryId}</span>
                                    )}
                                </td>
                                <td className="px-2 py-1.5 align-middle">
                                    <VersionChain
                                        installed={f.installedVersion}
                                        fix={f.fixVersion}
                                        vulnerableRange={f.vulnerableRange}
                                        fixAvailable={f.fixAvailable}
                                    />
                                </td>
                                <td className="px-2 py-1.5 align-middle font-mono text-muted-foreground" title={formatAbsoluteTime(f.firstDetectedAt)}>
                                    {formatRelativeTime(f.firstDetectedAt, tTime, now)}
                                </td>
                                <td className="px-2 py-1.5 align-middle text-right">
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
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}
