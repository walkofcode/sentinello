'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { RefreshCw, ShieldAlert } from 'lucide-react'
import type { OsvSourceStatus } from '@sentinello/core'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/lib/format'
import { refreshOsvAction, updateSourcesAction } from '@/lib/actions/settings'

type Props = {
    osvEnabled: boolean
    status: OsvSourceStatus | null
}

export function SourcesForm({ osvEnabled, status }: Props) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const tt = useTranslations('Time')
    const [enabled, setEnabled] = useState(osvEnabled)
    const [pending, startTransition] = useTransition()
    const [refreshing, startRefresh] = useTransition()
    const [refreshRequested, setRefreshRequested] = useState(false)

    function toggle(next: boolean) {
        setEnabled(next)
        startTransition(async function persist() {
            await updateSourcesAction({ osvEnabled: next })
        })
    }
    function refresh() {
        startRefresh(async function run() {
            await refreshOsvAction()
            setRefreshRequested(true)
        })
    }

    const freeGib = status && status.freeBytes !== null
        ? (status.freeBytes / (1024 * 1024 * 1024)).toFixed(1)
        : null

    return (
        <div className="space-y-6">
            <div className="space-y-4 rounded-(--radius-card) border bg-card p-6">
                <div>
                    <h2 className="text-sm font-semibold">{t('sources.title')}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{t('sources.description')}</p>
                </div>

                {/* npm audit — always-on built-in source, shown for context (not toggleable). */}
                <div className="flex items-start justify-between gap-4 rounded-md border bg-background p-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{t('sources.npmAuditLabel')}</span>
                            <Badge variant="npm">npm</Badge>
                            <Badge variant="muted">{t('sources.alwaysOn')}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{t('sources.npmAuditHelp')}</p>
                    </div>
                </div>

                {/* OSV — opt-in. */}
                <div className="rounded-md border bg-background p-4">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium">{t('sources.osvLabel')}</span>
                                <Badge variant="osv">OSV</Badge>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">{t('sources.osvHelp')}</p>
                        </div>
                        <label className="flex shrink-0 items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={enabled}
                                disabled={pending}
                                onChange={function onChange(e) { toggle(e.target.checked) }}
                                className="h-4 w-4"
                            />
                            {enabled ? t('sources.enabled') : t('sources.disabled')}
                        </label>
                    </div>

                    {/* Provisioning disclosure — shown whenever the source is off OR not yet seeded. */}
                    {!enabled || !status || !status.seedComplete ? (
                        <div className="mt-3 flex items-start gap-2 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>
                                {t('sources.downloadDisclosure')}
                                {freeGib !== null ? ' ' + t('sources.freeSpace', { gib: freeGib }) : ''}
                            </span>
                        </div>
                    ) : null}

                    {/* Sync status — only meaningful once enabled. */}
                    {enabled ? (
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
                </div>

                <div className="h-4 text-xs text-muted-foreground" aria-live="polite">
                    {pending ? tc('saving') : ''}
                </div>
            </div>
        </div>
    )
}
