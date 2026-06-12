'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { RefreshCw, ShieldAlert } from 'lucide-react'
import type { EcosystemId, EcosystemLanguage, SourceId, SourceStatus } from '@sentinello/core'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { EcosystemBadge } from '@/components/findings/ecosystem-badge'
import { formatRelativeTime } from '@/lib/format'
import { refreshSourceAction, updateSourceCellAction } from '@/lib/actions/settings'

export type SourceCellVM = {
    source: SourceId
    ecosystem: EcosystemId
    displayName: string
    enabled: boolean
    cacheBacked: boolean
    status: SourceStatus | null
}

export type LanguageRowVM = {
    ecosystem: EcosystemId
    language: EcosystemLanguage
    displayName: string
    cells: SourceCellVM[]
}

type Props = {
    rows: LanguageRowVM[]
}

// The source provenance badge (matches source-tags.tsx so Settings and the triage table read the same).
function sourceBadge(source: SourceId): { variant: BadgeProps['variant']; label: string } {
    if (source === 'osv') return { variant: 'osv', label: 'OSV' }
    if (source === 'npm-audit') return { variant: 'npm', label: 'npm' }
    if (source === 'gemnasium') return { variant: 'gemnasium', label: 'gemnasium' }
    return { variant: 'muted', label: source }
}

// Per-source help / provisioning copy keys. npm-audit runs live (no cache); OSV and gemnasium download an
// advisory export per enabled ecosystem.
function sourceHelpKey(source: SourceId): string {
    if (source === 'npm-audit') return 'sources.npmAuditHelp'
    if (source === 'osv') return 'sources.osvHelp'
    return 'sources.gemnasiumHelp'
}
function sourceDisclosureKey(source: SourceId): string {
    if (source === 'gemnasium') return 'sources.gemnasiumDownloadDisclosure'
    return 'sources.downloadDisclosure'
}

// The Languages × Sources matrix: rows = languages (from the central ECOSYSTEMS registry), cells =
// the sources that answer for that language. JavaScript ships npm-audit on (toggleable) plus optional
// OSV/gemnasium; Python/Go/Rust default off, each with OSV as the default cell + optional gemnasium. The
// "always a source on" invariant is enforced server-side on every toggle.
export function SourcesForm({ rows }: Props) {
    const t = useTranslations('Settings')

    return (
        <div className="space-y-6">
            <div className="space-y-2">
                <h2 className="text-sm font-semibold">{t('sources.title')}</h2>
                <p className="text-sm text-muted-foreground">{t('sources.description')}</p>
            </div>
            {rows.map(function languageBlock(row) {
                return (
                    <div key={row.ecosystem} className="space-y-3 rounded-(--radius-card) border bg-card p-6">
                        <div className="flex items-center gap-2">
                            <h3 className="text-sm font-semibold">{row.displayName}</h3>
                            <EcosystemBadge ecosystem={row.ecosystem} />
                        </div>
                        <div className="space-y-3">
                            {row.cells.map(function cell(c) {
                                const badge = sourceBadge(c.source)
                                return (
                                    <SourceCell
                                        key={c.source + ':' + c.ecosystem}
                                        cell={c}
                                        label={c.displayName}
                                        help={t(sourceHelpKey(c.source))}
                                        badge={<Badge variant={badge.variant}>{badge.label}</Badge>}
                                        disclosure={c.cacheBacked ? t(sourceDisclosureKey(c.source)) : null}
                                    />
                                )
                            })}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

type SourceCellProps = {
    cell: SourceCellVM
    label: string
    help: string
    badge: ReactNode
    disclosure: string | null
}

// One (source, ecosystem) cell: toggle + (for cache-backed sources) provisioning disclosure, sync status,
// and refresh. The toggle writes the single cell key; the server action enforces the "always a source on"
// invariant and rejects disabling the last active cell.
function SourceCell({ cell, label, help, badge, disclosure }: SourceCellProps) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const tt = useTranslations('Time')
    const [enabled, setEnabled] = useState(cell.enabled)
    const [pending, startTransition] = useTransition()
    const [refreshing, startRefresh] = useTransition()
    const [refreshRequested, setRefreshRequested] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const status = cell.status

    function toggle(next: boolean) {
        setError(null)
        // Optimistic flip; revert if the server rejects (e.g. the invariant blocks disabling the last cell).
        setEnabled(next)
        startTransition(async function persist() {
            try {
                await updateSourceCellAction({ source: cell.source, ecosystem: cell.ecosystem, enabled: next })
            } catch (e) {
                setEnabled(!next)
                setError(e instanceof Error ? e.message : String(e))
            }
        })
    }
    function refresh() {
        startRefresh(async function run() {
            await refreshSourceAction(cell.source)
            setRefreshRequested(true)
        })
    }

    const freeGib = status && status.freeBytes !== null
        ? (status.freeBytes / (1024 * 1024 * 1024)).toFixed(1)
        : null

    return (
        <div className="rounded-md border bg-background p-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{label}</span>
                        {badge}
                        {cell.cacheBacked ? (
                            <Badge variant="muted">{t('sources.optional')}</Badge>
                        ) : (
                            <Badge variant="muted">{t('sources.defaultOn')}</Badge>
                        )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{help}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2.5 text-sm">
                    <span className="text-muted-foreground">
                        {enabled ? t('sources.enabled') : t('sources.disabled')}
                    </span>
                    <Switch
                        checked={enabled}
                        disabled={pending}
                        onCheckedChange={toggle}
                        aria-label={label + ' · ' + cell.ecosystem}
                    />
                </div>
            </div>

            {error ? (
                <p className="mt-2 text-xs text-[color:var(--color-sev-high)]">{error}</p>
            ) : null}

            {/* Provisioning disclosure — cache-backed sources only, when off OR not yet seeded. */}
            {disclosure && (!enabled || !status || !status.seedComplete) ? (
                <div className="mt-3 flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        {disclosure}
                        {freeGib !== null ? ' ' + t('sources.freeSpace', { gib: freeGib }) : ''}
                    </span>
                </div>
            ) : null}

            {/* Sync status — cache-backed sources only, once enabled. */}
            {cell.cacheBacked && enabled ? (
                <div className="mt-3 space-y-2 border-t pt-3">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        <span className="text-muted-foreground">
                            {t('sources.syncStatus')}:{' '}
                            {status && status.seedComplete ? (
                                <span className="font-medium text-foreground">{t('sources.seeded')}</span>
                            ) : (
                                <span className="font-medium text-foreground">{t('sources.seeding')}</span>
                            )}
                        </span>
                        {status && status.seedComplete ? (
                            <span className="text-muted-foreground">
                                {t('sources.recordCount', { n: status.recordCount })}
                            </span>
                        ) : null}
                        <span className="text-muted-foreground">
                            {t('sources.lastRefreshed')}: {formatRelativeTime(status?.refreshedAt ?? null, tt)}
                        </span>
                    </div>
                    {status && status.lastError ? (
                        <p className="text-xs text-[color:var(--color-sev-high)]">
                            {t('sources.lastError')}: {status.lastError}
                        </p>
                    ) : null}
                    <div className="flex items-center gap-3 pt-1">
                        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
                            <RefreshCw className="h-4 w-4" />
                            {refreshing ? tc('saving') : t('sources.refreshNow')}
                        </Button>
                        {refreshRequested ? (
                            <span className="text-xs text-muted-foreground">{t('sources.refreshQueued')}</span>
                        ) : null}
                    </div>
                </div>
            ) : null}

            <div className="h-4 text-xs text-muted-foreground" aria-live="polite">
                {pending ? tc('saving') : ''}
            </div>
        </div>
    )
}
