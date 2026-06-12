'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { Mute, Severity } from '@sentinello/core'
import type { MergedFinding } from '@/lib/merge-findings'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MuteDialog } from '@/components/triage/mute-dialog'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/cn'
import { VersionChain } from './version-chain'
import { DepPathPopover } from './dep-path-popover'
import { SourceTags } from './source-tags'
import { EcosystemBadge } from './ecosystem-badge'

// The merged finding's ecosystem. A merged row is keyed by (ecosystem, package, advisory) (issue-019),
// so the row carries one ecosystem directly. Shown as a badge only for non-npm packages so npm-only
// projects stay uncluttered while a same-named package from another ecosystem is always distinguishable.
function findingEcosystem(f: MergedFinding): string | null {
    if (!f.ecosystem || f.ecosystem === 'npm') return null
    return f.ecosystem
}

type Props = {
    findings: MergedFinding[]
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
                    const matched = matchMutes(mutes, projectId, f)
                    const fullyMuted = f.identities.length > 0 && matched.length === f.identities.length
                    return (
                        <Card key={f.key} className={cn('p-4', fullyMuted && 'opacity-60')}>
                            <div className="flex flex-wrap items-center gap-1.5">
                                <SeverityPill variant={f.severity as Severity} size="sm" />
                                {f.malicious ? <Badge variant="malicious" className="px-2 py-0.5 text-[0.625rem] font-semibold tracking-wider ring-0">{t('malicious')}</Badge> : null}
                                <span className="flex min-w-0 flex-1 items-center gap-1">
                                    <span className="truncate font-medium text-sm">{f.packageName}</span>
                                    <DepPathPopover paths={f.depPaths} />
                                </span>
                                {findingEcosystem(f) ? <EcosystemBadge ecosystem={findingEcosystem(f) as string} /> : null}
                                {f.isDev && !f.isProd ? <Badge variant="dev">{t('dev')}</Badge> : null}
                            </div>
                            <dl className="mt-3 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 text-xs">
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.source')}</dt>
                                <dd className="flex flex-wrap gap-1"><SourceTags scanners={f.scanners} /></dd>
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
                                <dt className="uppercase tracking-wide text-muted-foreground">{t('columns.detected')}</dt>
                                <dd className="font-mono" title={formatAbsoluteTime(f.firstDetectedAt)}>
                                    {formatRelativeTime(f.firstDetectedAt, tTime, now)}
                                </dd>
                            </dl>
                            <div className="mt-3 flex justify-end border-t border-border/40 pt-3">
                                <MuteDialog projectId={projectId} merged={mergedTarget(f, matched, fullyMuted)} />
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
                            <TableHead>{t('columns.source')}</TableHead>
                            <TableHead>{t('columns.version')}</TableHead>
                            <TableHead>{t('columns.advisory')}</TableHead>
                            <TableHead>{t('columns.detected')}</TableHead>
                            <TableHead className="text-right">{t('columns.triage')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {findings.map(function row(f) {
                            const matched = matchMutes(mutes, projectId, f)
                            const fullyMuted = f.identities.length > 0 && matched.length === f.identities.length
                            return (
                                <TableRow key={f.key} className={fullyMuted ? 'opacity-60' : ''}>
                                    <TableCell>
                                        <div className="flex flex-wrap items-center gap-1">
                                            <SeverityPill variant={f.severity as Severity} size="sm" />
                                            {f.malicious ? <Badge variant="malicious" className="px-2 py-0.5 text-[0.625rem] font-semibold tracking-wider ring-0">{t('malicious')}</Badge> : null}
                                        </div>
                                    </TableCell>
                                    <TableCell className="font-medium">
                                        <span className="inline-flex items-center gap-1.5 align-middle">
                                            <span>{f.packageName}</span>
                                            <DepPathPopover paths={f.depPaths} />
                                        </span>
                                        {findingEcosystem(f) ? <EcosystemBadge ecosystem={findingEcosystem(f) as string} className="ml-2" /> : null}
                                        {f.isDev && !f.isProd ? (
                                            <Badge variant="dev" className="ml-2">{t('dev')}</Badge>
                                        ) : null}
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex flex-wrap gap-1"><SourceTags scanners={f.scanners} /></div>
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
                                    <TableCell className="font-mono text-xs">
                                        <span title={formatAbsoluteTime(f.firstDetectedAt)}>
                                            {formatRelativeTime(f.firstDetectedAt, tTime, now)}
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <MuteDialog projectId={projectId} merged={mergedTarget(f, matched, fullyMuted)} iconOnly />
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

function mergedTarget(f: MergedFinding, matched: Mute[], fullyMuted: boolean) {
    return {
        packageName: f.packageName,
        advisories: f.identities,
        muteIds: fullyMuted ? matched.map(function id(m) { return m.id }) : []
    }
}

// A merged row is muted only when every one of its underlying (source, ecosystem, advisoryId)
// identities has an active matching mute — a partial mute still reads as actionable so the remaining
// ones can be silenced. mutes.scanner holds the persisted source identity (issue-016), so match it
// against the finding's source, never the plugin scanner name.
function matchMutes(mutes: Mute[], projectId: string, f: MergedFinding): Mute[] {
    const out: Mute[] = []
    for (const identity of f.identities) {
        const hit = mutes.find(function find(m): boolean {
            return (
                m.scope === 'finding' &&
                (m.projectId === null || m.projectId === projectId) &&
                m.scanner === identity.source &&
                (m.ecosystem === null || m.ecosystem === identity.ecosystem) &&
                m.advisoryId === identity.advisoryId &&
                m.packageName === f.packageName
            )
        })
        if (hit) out.push(hit)
    }
    return out
}
