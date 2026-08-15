'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import { ECOSYSTEMS, type EcosystemId, type EcosystemLanguage, type SourceId, type SourceStatus } from '@sentinello/core'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { EcosystemBadge } from '@/components/findings/ecosystem-badge'
import { SaveStatus } from '@/components/settings/save-status'
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

// Read off the registry rather than named in the copy, so promoting an ecosystem retires the note
// on its own instead of leaving a sentence that still calls a shipped language "in development".
const PREVIEW_ECOSYSTEMS = ECOSYSTEMS.filter(function preview(eco) {
    return eco.status === 'preview'
})

// The source provenance badge (matches source-tags.tsx so Settings and the triage table read the same).
function sourceBadge(source: SourceId): { variant: BadgeProps['variant']; label: string } {
    if (source === 'osv') return { variant: 'osv', label: 'OSV' }
    if (source === 'npm-audit') return { variant: 'npm', label: 'npm' }
    if (source === 'gemnasium') return { variant: 'gemnasium', label: 'gemnasium' }
    return { variant: 'muted', label: source }
}

// The controls only. What each source IS — what it adds, what it downloads, when it acts — lives in
// SourceReferenceTable below this on the page: that copy is per-source, while these switches are
// per (source, ecosystem) cell, so repeating it here restated the same paragraph once per language.
//
// Rows come from the central ECOSYSTEMS registry; only 'stable' ecosystems are offered, so today this
// is Node.js alone. The "always a source on" invariant is enforced server-side on every toggle.
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
                    <div key={row.ecosystem} className="space-y-1 rounded-(--radius-card) border bg-card p-6">
                        <div className="flex items-center gap-2 pb-2">
                            <h3 className="text-sm font-semibold">{row.displayName}</h3>
                            <EcosystemBadge ecosystem={row.ecosystem} />
                        </div>
                        <div className="divide-y">
                            {row.cells.map(function cell(c) {
                                const badge = sourceBadge(c.source)
                                return (
                                    <SourceCell
                                        key={c.source + ':' + c.ecosystem}
                                        cell={c}
                                        label={c.displayName}
                                        badge={<Badge variant={badge.variant}>{badge.label}</Badge>}
                                    />
                                )
                            })}
                        </div>
                    </div>
                )
            })}
            {PREVIEW_ECOSYSTEMS.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                    {t('sources.previewNote', { names: PREVIEW_ECOSYSTEMS.map(ecosystemName).join(', ') })}
                </p>
            ) : null}
        </div>
    )
}

function ecosystemName(eco: { displayName: string }): string {
    return eco.displayName
}

type SourceCellProps = {
    cell: SourceCellVM
    label: string
    badge: ReactNode
}

// One (source, ecosystem) cell: the switch, plus — for cache-backed sources that are on — a single
// line of sync state and an icon-only refresh. The toggle writes the single cell key; the server
// action enforces the "always a source on" invariant and rejects disabling the last active cell.
//
// The refresh signal is per SOURCE, not per cell (refreshSourceAction takes only the source id), so
// once a second ecosystem ships this button will repeat across that source's rows and should be
// hoisted to one control per source.
function SourceCell({ cell, label, badge }: SourceCellProps) {
    const t = useTranslations('Settings')
    const tt = useTranslations('Time')
    const [enabled, setEnabled] = useState(cell.enabled)
    const [saved, setSaved] = useState(false)
    const [pending, startTransition] = useTransition()
    const [refreshing, startRefresh] = useTransition()
    const [refreshRequested, setRefreshRequested] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const status = cell.status

    function toggle(next: boolean) {
        setError(null)
        setSaved(false)
        // Optimistic flip; revert if the server rejects (e.g. the invariant blocks disabling the last cell).
        setEnabled(next)
        startTransition(async function persist() {
            // The rejection arrives as a VALUE, not a throw. It used to be caught from a throw, which
            // meant the operator read Next.js's production redaction paragraph instead of the reason —
            // on the one control whose whole job is to stop Sentinello going blind.
            const result = await updateSourceCellAction({
                source: cell.source,
                ecosystem: cell.ecosystem,
                enabled: next
            })
            if (!result.ok) {
                setEnabled(!next)
                setError(result.errorText)
                return
            }
            setSaved(true)
        })
    }
    function refresh() {
        startRefresh(async function run() {
            await refreshSourceAction(cell.source)
            setRefreshRequested(true)
        })
    }

    const seeded = status !== null && status.seedComplete
    const failing = status !== null && status.lastError !== null
    const freeGib = status && status.freeBytes !== null
        ? (status.freeBytes / (1024 * 1024 * 1024)).toFixed(1)
        : null

    return (
        <div className="py-3">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{label}</span>
                        {badge}
                        {cell.cacheBacked ? (
                            <Badge variant="muted">{t('sources.optional')}</Badge>
                        ) : (
                            <Badge variant="muted">{t('sources.defaultOn')}</Badge>
                        )}
                    </div>

                    {/* Sync state, one line. It used to be a bordered band of three stacked rows with a
                        full-size button; every field it carried is still here. */}
                    {cell.cacheBacked && enabled ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <span aria-hidden className={'size-1.5 shrink-0 rounded-full ' + stateDotClass(seeded, failing)} />
                            <span className="font-medium text-foreground">
                                {seeded ? t('sources.seeded') : t('sources.seeding')}
                            </span>
                            {seeded ? (
                                <>
                                    <span aria-hidden>·</span>
                                    <span>{t('sources.recordCount', { n: status.recordCount })}</span>
                                </>
                            ) : null}
                            <span aria-hidden>·</span>
                            <span>
                                <span className="sr-only">{t('sources.lastRefreshed')}: </span>
                                {formatRelativeTime(status?.refreshedAt ?? null, tt)}
                            </span>
                            {freeGib !== null ? (
                                <>
                                    <span aria-hidden>·</span>
                                    <span>{t('sources.freeSpace', { gib: freeGib })}</span>
                                </>
                            ) : null}
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                onClick={refresh}
                                disabled={refreshing}
                                aria-label={t('sources.refreshNow')}
                            >
                                <RefreshCw className={'h-3.5 w-3.5' + (refreshing ? ' animate-spin' : '')} />
                            </Button>
                        </div>
                    ) : null}

                    {/* A sync failure is status, not a rejected write — no role="alert" here, so the
                        toggle rejection below stays the only thing that interrupts a screen reader. */}
                    {status && status.lastError ? (
                        <p className="mt-1 text-xs text-[color:var(--color-sev-high)]">
                            {t('sources.lastError')}: {status.lastError}
                        </p>
                    ) : null}

                    {refreshRequested ? (
                        <p className="mt-1 text-xs text-muted-foreground">{t('sources.refreshQueued')}</p>
                    ) : null}
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

            <SaveStatus pending={pending} saved={saved} error={error} />
        </div>
    )
}

function stateDotClass(seeded: boolean, failing: boolean): string {
    if (failing) return 'bg-[color:var(--color-sev-high)]'
    if (seeded) return 'bg-success'
    return 'bg-warning'
}
