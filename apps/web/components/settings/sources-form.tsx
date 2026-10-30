'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { sourceNormalizerVersion, type EcosystemId, type EcosystemLanguage, type SourceId, type SourceStatus } from '@sentinello/core'
import { Button } from '@/components/ui/button'
import { ScanAutoRefresh } from '@/components/scan-auto-refresh'
import { Switch } from '@/components/ui/switch'
import { formatRelativeTime } from '@/lib/format'
import { isRefreshPending, type RefreshBaseline } from '@/lib/source-refresh'
import { refreshSourceAction, turnOnSourceForEcosystemAction, updateSourceCellAction } from '@/lib/actions/settings'

export type SourceCellVM = {
    source: SourceId
    ecosystem: EcosystemId
    displayName: string
    enabled: boolean
    cacheBacked: boolean
    // The built-in source — on out of the box and not something an operator turns off. Its switch is
    // locked once on; the server refuses the write regardless.
    builtIn: boolean
    status: SourceStatus | null
}

export type LanguageRowVM = {
    ecosystem: EcosystemId
    language: EcosystemLanguage
    displayName: string
    cells: SourceCellVM[]
    // Detected projects in this language that no enabled source answers for. Above zero, the block offers
    // to turn a source on.
    projectsWithoutSource: number
}

type Props = {
    rows: LanguageRowVM[]
}

// The controls only. What each source IS — what it adds, what it downloads, when it acts — lives in
// SourceReferenceTable below this on the page: that copy is per-source, while these switches are
// per (source, ecosystem) cell, so repeating it here restated the same paragraph once per language.
//
// One line per source. The ecosystem name is a heading ABOVE its panel, not a row inside it, and no
// row carries a provenance badge: a pill reading "OSV" beside the words "OSV" is the same word twice.
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
                    <div key={row.ecosystem} className="space-y-2">
                        <h3 className="text-sm font-semibold">{row.displayName}</h3>
                        {row.projectsWithoutSource > 0 ? <TurnOnSource row={row} /> : null}
                        <div className="divide-y rounded-(--radius-card) border bg-card px-5">
                            {row.cells.map(function cell(c) {
                                return <SourceCell key={c.source + ':' + c.ecosystem} cell={c} label={c.displayName} />
                            })}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

// "No source enabled for Python", with one button per source that could answer for it: "Turn on OSV for
// Python". A click enables that cell, has the worker download its advisories, and queues a re-scan
// (turnOnSourceForEcosystemAction), so the projects behind the count are scanned without a second step.
// Once the page re-renders with the cell on, no project lacks a source and this notice is gone.
function TurnOnSource({ row }: { row: LanguageRowVM }) {
    const t = useTranslations('Settings')
    const [pending, startTransition] = useTransition()
    const [error, setError] = useState<string | null>(null)
    const offered = row.cells.filter(function off(c) { return !c.enabled })

    function turnOn(cell: SourceCellVM) {
        setError(null)
        startTransition(async function persist() {
            const result = await turnOnSourceForEcosystemAction({ source: cell.source, ecosystem: cell.ecosystem })
            if (!result.ok) setError(result.errorText)
        })
    }

    return (
        <div data-testid={'turn-on-source-' + row.ecosystem} className="space-y-2 rounded-(--radius-card) border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <p className="text-sm font-medium">{t('sources.turnOnTitle', { language: row.displayName })}</p>
            </div>
            <p className="text-xs text-muted-foreground">
                {t('sources.turnOnBody', { count: row.projectsWithoutSource, language: row.displayName })}
            </p>
            <div className="flex flex-wrap gap-2">
                {offered.map(function button(c) {
                    return (
                        <Button key={c.source} type="button" size="sm" disabled={pending} onClick={function click() { turnOn(c) }}>
                            {t('sources.turnOn', { source: c.displayName, language: row.displayName })}
                        </Button>
                    )
                })}
            </div>
            {error ? (
                <p role="alert" className="text-xs text-[color:var(--color-sev-high)]">{error}</p>
            ) : null}
        </div>
    )
}

type SourceCellProps = {
    cell: SourceCellVM
    label: string
}

// One (source, ecosystem) cell on one row: name, whether it is the built-in, its sync state when it has
// one, and the switch. The toggle writes the single cell key; the server action enforces the "always a
// source on" invariant and rejects disabling the last runnable cell.
//
// This page does NOT use the shared <SaveStatus />, which every other settings form does. That component
// reserves a line of height for one form with one save button; here there are N independent switches, so
// it reserved N lines and pushed three rows over 500px. The same answers appear in the same place
// instead — the word beside the switch you just moved, in a live region — and a rejected write still
// interrupts through role="alert".
//
// The refresh signal is per SOURCE, not per cell (refreshSourceAction takes only the source id), so
// once a second ecosystem ships this button will repeat across that source's rows and should be
// hoisted to one control per source.
function SourceCell({ cell, label }: SourceCellProps) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const tt = useTranslations('Time')
    const [enabled, setEnabled] = useState(cell.enabled)
    // The persisted flag this cell last rendered with. A cell switched on from outside the switch — the
    // "Turn on OSV for Python" action above — arrives as a new prop, and the switch has to follow it rather
    // than keep the state it was mounted with. Adjusted during render, React's pattern for state derived
    // from a prop; the switch's own optimistic flip lands on the same value, so it is left untouched.
    const [persisted, setPersisted] = useState(cell.enabled)
    if (persisted !== cell.enabled) {
        setPersisted(cell.enabled)
        setEnabled(cell.enabled)
    }
    const [saved, setSaved] = useState(false)
    const [pending, startTransition] = useTransition()
    const [refreshing, startRefresh] = useTransition()
    // What this cell's status looked like when a refresh was asked for. The worker exposes no
    // "syncing" state — only the SourceStatus snapshot it writes when a sync ENDS — so "still
    // running" is derived by comparing against this baseline rather than stored anywhere.
    const [refreshBaseline, setRefreshBaseline] = useState<RefreshBaseline | null>(null)
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
            setRefreshBaseline({ refreshedAt: status?.refreshedAt ?? null, lastError: status?.lastError ?? null })
        })
    }

    // The cache the SCANNER will actually use, from the same two facts its isSeeded gate reads
    // (apps/worker/src/osv-runtime.ts osvCacheUsable). `seedComplete` alone is what let this row say
    // "Up to date" for the whole of a multi-minute rebuild while every scan returned osv_db_not_seeded
    // — and a normalizer bump reproduced it with no rebuild window at all.
    //
    // `?? null` on the two newer fields, deliberately: an app_config row written by an older worker
    // genuinely lacks them until the worker re-mirrors at boot. A missing stamp must read as "not the
    // current one" (fail closed, exactly as the scanner does), and a missing syncStartedAt as "nothing
    // running" — `undefined !== null` is true and would pin the row to "Rebuilding…" forever.
    const usable = status !== null
        && status.seedComplete
        && (status.normalizerVersion ?? null) === sourceNormalizerVersion(cell.source, cell.ecosystem)
    // Non-zero only once a sync has actually landed rows, so a first-ever download shows no count rather
    // than "0 advisories cached". recordCount is NOT recomputed during a rebuild, so this is the
    // pre-rebuild figure — which is the one worth showing.
    const everSeeded = status !== null && status.recordCount > 0
    // Worker-stamped, so unlike the old client-memory baseline this survives a page reload.
    const syncing = status !== null && (status.syncStartedAt ?? null) !== null
    const failing = status !== null && status.lastError !== null
    // Derived during render, not tracked in an effect: `status` is a server prop, so once the worker
    // writes a newer snapshot (or a new error) the very next render flips this false and leaves it
    // false. The baseline covers only the <=5s between clicking Refresh and the worker claiming the
    // refresh-* signal, before anything has stamped syncStartedAt. After that `syncing` is the truth,
    // and it survives a reload where the baseline never did.
    const refreshPending = isRefreshPending(status, refreshBaseline)

    return (
        <div className="py-3">
            <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium">{label}</span>

                    {/* Sync state on the SAME line as the name and the switch. It used to be a bordered
                        band of three stacked rows below them; every field it carried is still here. */}
                    {cell.cacheBacked && enabled ? (
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span aria-hidden className={'size-1.5 shrink-0 rounded-full ' + stateDotClass(usable, failing)} />
                            <span className="font-medium text-foreground">
                                {t(cacheStateKey(usable, everSeeded, syncing))}
                            </span>
                            {everSeeded ? (
                                <>
                                    <span aria-hidden>·</span>
                                    {/* Dimmed, not hidden. During a rebuild this is the count from BEFORE
                                        it — the number the operator wants back — but it is not what the
                                        scanner can match right now, and rendering it at full weight beside
                                        "Rebuilding…" would say otherwise. */}
                                    <span className={usable ? '' : 'opacity-60'}>
                                        {t('sources.recordCount', { n: status.recordCount })}
                                    </span>
                                </>
                            ) : null}
                            <span aria-hidden>·</span>
                            <span>
                                <span className="sr-only">{t('sources.lastRefreshed')}: </span>
                                {formatRelativeTime(status?.refreshedAt ?? null, tt)}
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-6"
                                onClick={refresh}
                                disabled={refreshing || refreshPending}
                                aria-label={t('sources.refreshNow')}
                            >
                                <RefreshCw className={'h-3.5 w-3.5' + (refreshing || refreshPending ? ' animate-spin' : '')} />
                            </Button>
                        </span>
                    ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-2.5 text-sm">
                    <span className="text-muted-foreground" aria-live="polite">
                        {toggleLabel(pending, saved, enabled, tc, t)}
                    </span>
                    {/* The built-in source cannot be switched off — it is what Sentinello scans with.
                        Locked only once it is ON, so a cell an operator could never have turned off
                        themselves is still recoverable from the UI rather than needing a DB write. */}
                    <Switch
                        checked={enabled}
                        disabled={pending || (cell.builtIn && enabled)}
                        onCheckedChange={toggle}
                        aria-label={label + ' · ' + cell.ecosystem}
                    />
                </div>
            </div>

            {/* Both of these are rare and transient, so they cost no height until they have something to
                say. A sync failure is status, not a rejected write — no role="alert" on it, leaving the
                invariant rejection as the only thing that interrupts a screen reader. */}
            {status && status.lastError ? (
                <p className="mt-1.5 text-xs text-[color:var(--color-sev-high)]">
                    {t('sources.lastError')}: {status.lastError}
                </p>
            ) : null}
            {refreshPending ? (
                <>
                    {/* Only while pending, and faster than the app-wide idle cadence: this is the one
                        screen where the operator is actively waiting on a background job to land.
                        Unmounting when it lands is what stops N cells owning N idle timers. Polls for a
                        cron-triggered sync too, but the "Refresh requested" line stays gated on the
                        baseline — a rebuild nobody asked for must not claim the operator asked for it. */}
                    <ScanAutoRefresh active activeIntervalMs={10000} />
                    {refreshBaseline !== null ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">{t('sources.refreshQueued')}</p>
                    ) : null}
                </>
            ) : null}
            {error ? (
                <p role="alert" className="mt-1.5 text-xs text-[color:var(--color-sev-high)]">{error}</p>
            ) : null}
        </div>
    )
}

type Translate = (key: string) => string

function toggleLabel(pending: boolean, saved: boolean, enabled: boolean, tc: Translate, t: Translate): string {
    if (pending) return tc('saving')
    if (saved) return tc('saved')
    return enabled ? t('sources.enabled') : t('sources.disabled')
}

// Four outcomes, three of which the old binary seeded/seeding pair collapsed into one lie. The fourth —
// had rows, cannot use them, and nothing is currently doing anything about it — is the difference between
// "wait" and "this is stuck", and it is the state a normalizer bump leaves behind.
function cacheStateKey(usable: boolean, everSeeded: boolean, syncing: boolean): string {
    if (usable) return 'sources.seeded'
    if (!everSeeded) return 'sources.seeding'
    if (syncing) return 'sources.rebuilding'
    return 'sources.rebuildPending'
}

function stateDotClass(usable: boolean, failing: boolean): string {
    if (failing) return 'bg-[color:var(--color-sev-high)]'
    if (usable) return 'bg-success'
    return 'bg-warning'
}
