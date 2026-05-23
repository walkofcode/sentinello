'use client'

import { useState, type KeyboardEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import type { Severity } from '@sentinello/core'
import { Badge } from '@/components/ui/badge'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export type ScanFindingVM = {
    id: string
    severity: Severity
    packageName: string
    installedVersion: string
    advisoryId: string
}

export type ScanHistoryRowVM = {
    id: string
    finishedRelative: string
    finishedAbsolute: string
    statusLabel: string
    statusOk: boolean
    reasonLabel: string | null
    errorText: string | null
    discovered: ScanFindingVM[]
    resolved: ScanFindingVM[]
}

type Props = {
    scans: ScanHistoryRowVM[]
}

export function ScanHistory({ scans }: Props) {
    return (
        <>
            <div className="space-y-2 md:hidden">
                {scans.map(function card(scan) {
                    return <ScanCard key={scan.id} scan={scan} />
                })}
            </div>
            <div className="hidden md:block">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-8"></TableHead>
                            <ScanTableHeads />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {scans.map(function row(scan) {
                            return <ScanRow key={scan.id} scan={scan} />
                        })}
                    </TableBody>
                </Table>
            </div>
        </>
    )
}

function ScanTableHeads() {
    const t = useTranslations('Detail')
    return (
        <>
            <TableHead>{t('project.scanTable.finished')}</TableHead>
            <TableHead>{t('project.scanTable.status')}</TableHead>
            <TableHead>{t('project.scanTable.changes')}</TableHead>
        </>
    )
}

function ScanRow({ scan }: { scan: ScanHistoryRowVM }) {
    const t = useTranslations('Detail')
    const [open, setOpen] = useState(false)
    const changeCount = scan.discovered.length + scan.resolved.length
    const expandable = changeCount > 0
    function toggle() {
        if (expandable) setOpen(!open)
    }
    function onKeyDown(e: KeyboardEvent<HTMLTableRowElement>) {
        if (!expandable) return
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(!open)
        }
    }
    return (
        <>
            <TableRow
                onClick={expandable ? toggle : undefined}
                onKeyDown={onKeyDown}
                role={expandable ? 'button' : undefined}
                tabIndex={expandable ? 0 : undefined}
                aria-expanded={expandable ? open : undefined}
                aria-label={expandable ? t('project.scanTable.toggleChanges') : undefined}
                className={expandable ? 'cursor-pointer' : ''}
            >
                <TableCell className="align-top">
                    {expandable ? (
                        <span className="text-muted-foreground">
                            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </span>
                    ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs">
                    <span title={scan.finishedAbsolute}>{scan.finishedRelative}</span>
                </TableCell>
                <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={scan.statusOk ? 'default' : 'outline'}>{scan.statusLabel}</Badge>
                        {scan.reasonLabel ? <Badge variant="outline">{scan.reasonLabel}</Badge> : null}
                    </div>
                </TableCell>
                <TableCell className="text-xs">
                    <ChangeSummary scan={scan} />
                </TableCell>
            </TableRow>
            {open && expandable ? (
                <TableRow>
                    <TableCell colSpan={4} className="bg-muted/20 p-4">
                        <ChangeDetail scan={scan} />
                    </TableCell>
                </TableRow>
            ) : null}
        </>
    )
}

function ScanCard({ scan }: { scan: ScanHistoryRowVM }) {
    const t = useTranslations('Detail')
    const [open, setOpen] = useState(false)
    const changeCount = scan.discovered.length + scan.resolved.length
    const expandable = changeCount > 0
    function toggle() {
        if (expandable) setOpen(!open)
    }
    function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
        if (!expandable) return
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(!open)
        }
    }
    return (
        <Card
            onClick={expandable ? toggle : undefined}
            onKeyDown={onKeyDown}
            role={expandable ? 'button' : undefined}
            tabIndex={expandable ? 0 : undefined}
            aria-expanded={expandable ? open : undefined}
            aria-label={expandable ? t('project.scanTable.toggleChanges') : undefined}
            className={'p-4 ' + (expandable ? 'cursor-pointer' : '')}
        >
            <div className="flex items-center gap-2">
                <Badge variant={scan.statusOk ? 'default' : 'outline'}>{scan.statusLabel}</Badge>
                {scan.reasonLabel ? <Badge variant="outline">{scan.reasonLabel}</Badge> : null}
                <span className="ml-auto font-mono text-xs text-muted-foreground" title={scan.finishedAbsolute}>
                    {scan.finishedRelative}
                </span>
                {expandable ? (
                    <span className="text-muted-foreground">
                        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </span>
                ) : null}
            </div>
            <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                <dt className="uppercase tracking-wide text-muted-foreground">{t('project.scanTable.changes')}</dt>
                <dd className="min-w-0"><ChangeSummary scan={scan} /></dd>
                {scan.errorText ? (
                    <>
                        <dt className="uppercase tracking-wide text-muted-foreground">{t('project.scanTable.detail')}</dt>
                        <dd className="min-w-0 break-words text-muted-foreground">{scan.errorText}</dd>
                    </>
                ) : null}
            </dl>
            {open && expandable ? (
                <div className="mt-3 border-t border-border/40 pt-3">
                    <ChangeDetail scan={scan} />
                </div>
            ) : null}
        </Card>
    )
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'moderate', 'low', 'info']

function countBySeverity(findings: ScanFindingVM[]): Record<Severity, number> {
    const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 }
    for (const f of findings) {
        counts[f.severity] = counts[f.severity] + 1
    }
    return counts
}

// In-row summary: the per-severity breakdown of what this scan discovered (SeverityPill hides any
// zero count), plus a compact resolved count. The expanded detail lists the individual findings.
function ChangeSummary({ scan }: { scan: ScanHistoryRowVM }) {
    const t = useTranslations('Detail')
    if (scan.discovered.length === 0 && scan.resolved.length === 0) {
        return <span className="text-muted-foreground">{t('project.scanTable.noChanges')}</span>
    }
    const counts = countBySeverity(scan.discovered)
    return (
        <span className="flex flex-wrap items-center gap-1.5">
            {SEVERITY_ORDER.map(function pill(s) {
                return <SeverityPill key={s} variant={s} count={counts[s]} size="sm" />
            })}
            {scan.resolved.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-2 py-0.5 text-white">
                    <Check className="h-3 w-3" />
                    <span className="text-[0.625rem] font-semibold uppercase tracking-wider">
                        {t('project.scanTable.resolvedCount', { count: scan.resolved.length })}
                    </span>
                </span>
            ) : null}
        </span>
    )
}

function ChangeDetail({ scan }: { scan: ScanHistoryRowVM }) {
    const t = useTranslations('Detail')
    return (
        <div className="grid gap-4 sm:grid-cols-2">
            {scan.discovered.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-destructive">
                        {t('project.scanTable.discovered')}
                    </span>
                    {scan.discovered.map(function f(finding) {
                        return <FindingLine key={finding.id} finding={finding} />
                    })}
                </div>
            ) : null}
            {scan.resolved.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-500">
                        {t('project.scanTable.resolved')}
                    </span>
                    {scan.resolved.map(function f(finding) {
                        return <FindingLine key={finding.id} finding={finding} />
                    })}
                </div>
            ) : null}
        </div>
    )
}

function FindingLine({ finding }: { finding: ScanFindingVM }) {
    return (
        <div className="flex items-center gap-2 text-xs">
            <SeverityPill variant={finding.severity} size="sm" />
            <span className="font-mono">{finding.packageName}@{finding.installedVersion}</span>
            <span className="text-muted-foreground">({finding.advisoryId})</span>
        </div>
    )
}
