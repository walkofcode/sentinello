'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Plus, Trash2, Power, Pencil, Send, History, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Label } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SeverityPill } from '@/components/ui/severity-pill'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { AddTargetDialog } from '@/components/settings/add-target-dialog'
import { RootScopeField, modeFromScope, type RootScopeMode } from '@/components/settings/root-scope-field'
import { SeverityFilterPills } from '@/components/settings/severity-filter-pills'
import { EnvFilterField } from '@/components/settings/env-filter-field'
import type { DepTypeFilter, NotificationTarget, Project, Root, Severity } from '@sentinello/core'
import {
    deleteNotificationTargetAction,
    duplicateNotificationTargetAction,
    sendHistoricalToTargetAction,
    setNotificationTargetEnabledAction,
    testSendNotificationTargetAction,
    updateNotificationTargetAction
} from '@/lib/actions/settings'

type ActionFeedback = {
    targetId: string
    kind: 'test' | 'history'
    ok: boolean
    message: string
}

type Props = {
    targets: NotificationTarget[]
    roots: Root[]
    projects: Project[]
}

export function NotificationTargetList({ targets, roots, projects }: Props) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const [pending, startTransition] = useTransition()
    const [editingId, setEditingId] = useState<string | null>(null)
    const [feedback, setFeedback] = useState<ActionFeedback | null>(null)
    const [addOpen, setAddOpen] = useState(false)
    // Confirm-then-delete: the trash icon stages the row id, the modal commits via deleteNotificationTargetAction.
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
    const pendingTarget = pendingDeleteId && targets.find(function byId(x) { return x.id === pendingDeleteId }) || null
    function toggle(id: string, enabled: boolean) {
        startTransition(async function persist() {
            await setNotificationTargetEnabledAction(id, !enabled)
        })
    }
    function requestDelete(id: string) {
        setFeedback(null)
        setPendingDeleteId(id)
    }
    function cancelDelete() {
        if (pending) return
        setPendingDeleteId(null)
    }
    function confirmDelete() {
        if (!pendingDeleteId) return
        const id = pendingDeleteId
        startTransition(async function persist() {
            await deleteNotificationTargetAction(id)
            if (editingId === id) setEditingId(null)
            setPendingDeleteId(null)
        })
    }
    function testSend(id: string) {
        setFeedback(null)
        startTransition(async function fire() {
            const result = await testSendNotificationTargetAction(id)
            if (result.ok) {
                setFeedback({ targetId: id, kind: 'test', ok: true, message: t('notifications.testDelivered') })
            } else {
                setFeedback({ targetId: id, kind: 'test', ok: false, message: t('notifications.testFailed', { error: result.errorText || t('notifications.unknownError') }) })
            }
        })
    }
    function sendHistory(id: string) {
        setFeedback(null)
        startTransition(async function fire() {
            const result = await sendHistoricalToTargetAction(id)
            setFeedback({
                targetId: id,
                kind: 'history',
                ok: true,
                message: t('notifications.historyQueued', { count: result.inserted })
            })
        })
    }
    function duplicate(id: string) {
        setFeedback(null)
        startTransition(async function clone() {
            await duplicateNotificationTargetAction(id)
        })
    }
    return (
        <div className="space-y-4">
            {feedback ? (
                <div
                    className={
                        'rounded-md border px-4 py-3 text-sm ' +
                        (feedback.ok ? 'border-success/40 bg-success/10' : 'border-destructive/40 bg-destructive/10')
                    }
                >
                    {feedback.message}
                </div>
            ) : null}
            {targets.length === 0 ? (
                <EmptyState
                    title={t('notifications.emptyTitle')}
                    description={t('notifications.emptyDescription')}
                >
                    <Button onClick={function openAdd() { setAddOpen(true) }}>
                        <Plus className="h-4 w-4" />
                        {t('notifications.addButton')}
                    </Button>
                </EmptyState>
            ) : (
                <>
                    <div className="flex justify-end">
                        <Button onClick={function openAdd() { setAddOpen(true) }}>
                            <Plus className="h-4 w-4" />
                            {t('notifications.addButton')}
                        </Button>
                    </div>
                    <div className="space-y-2 md:hidden">
                        {targets.map(function card(t) {
                            const isEditing = editingId === t.id
                            return (
                                <TargetCard
                                    key={t.id}
                                    target={t}
                                    roots={roots}
                                    projects={projects}
                                    isEditing={isEditing}
                                    pending={pending}
                                    onToggle={function onToggle() { toggle(t.id, t.enabled) }}
                                    onRemove={function onRemove() { requestDelete(t.id) }}
                                    onTest={function onTest() { testSend(t.id) }}
                                    onHistory={function onHistory() { sendHistory(t.id) }}
                                    onDuplicate={function onDuplicate() { duplicate(t.id) }}
                                    onEdit={function onEdit() {
                                        setFeedback(null)
                                        setEditingId(isEditing ? null : t.id)
                                    }}
                                    onSaved={function onSaved() { setEditingId(null) }}
                                />
                            )
                        })}
                    </div>
                    <div className="hidden md:block">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{t('notifications.kind')}</TableHead>
                                    <TableHead>{t('notifications.identity')}</TableHead>
                                    <TableHead>{t('notifications.severityFilter')}</TableHead>
                                    <TableHead>{t('notifications.scope')}</TableHead>
                                    <TableHead>{t('notifications.enabled')}</TableHead>
                                    <TableHead className="text-right"></TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {targets.map(function row(t) {
                                    const isEditing = editingId === t.id
                                    return (
                                        <TargetRow
                                            key={t.id}
                                            target={t}
                                            roots={roots}
                                            projects={projects}
                                            isEditing={isEditing}
                                            pending={pending}
                                            onToggle={function onToggle() { toggle(t.id, t.enabled) }}
                                            onRemove={function onRemove() { requestDelete(t.id) }}
                                            onTest={function onTest() { testSend(t.id) }}
                                            onHistory={function onHistory() { sendHistory(t.id) }}
                                            onDuplicate={function onDuplicate() { duplicate(t.id) }}
                                            onEdit={function onEdit() {
                                                setFeedback(null)
                                                setEditingId(isEditing ? null : t.id)
                                            }}
                                            onSaved={function onSaved() { setEditingId(null) }}
                                        />
                                    )
                                })}
                            </TableBody>
                        </Table>
                    </div>
                </>
            )}
            <AddTargetDialog open={addOpen} onClose={function close() { setAddOpen(false) }} roots={roots} projects={projects} />
            <ConfirmDialog
                open={pendingTarget !== null}
                onClose={cancelDelete}
                onConfirm={confirmDelete}
                title={t('notifications.deleteConfirm.title')}
                description={pendingTarget && t('notifications.deleteConfirm.description', { identity: maskedIdentity(pendingTarget) }) || ''}
                confirmLabel={t('notifications.deleteConfirm.confirm')}
                cancelLabel={tc('cancel')}
                destructive
                pending={pending}
            />
        </div>
    )
}

function TargetRow(props: {
    target: NotificationTarget
    roots: Root[]
    projects: Project[]
    isEditing: boolean
    pending: boolean
    onToggle: () => void
    onRemove: () => void
    onTest: () => void
    onHistory: () => void
    onDuplicate: () => void
    onEdit: () => void
    onSaved: () => void
}) {
    const tr = useTranslations('Settings')
    const t = props.target
    return (
        <>
            <TableRow>
                <TableCell className="uppercase tracking-wide text-xs">{t.kind}</TableCell>
                <TableCell className="font-mono text-xs">{maskedIdentity(t)}</TableCell>
                <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                        {t.severityFilter.map(function sev(s) {
                            return <SeverityPill key={s} variant={s} size="sm" />
                        })}
                    </div>
                </TableCell>
                <TableCell>
                    <ScopeBadge target={t} roots={props.roots} projects={props.projects} />
                </TableCell>
                <TableCell>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={props.onToggle}
                        disabled={props.pending}
                    >
                        <Power className={'h-4 w-4 ' + (t.enabled ? 'text-success' : 'text-muted-foreground')} />
                        {t.enabled ? tr('notifications.on') : tr('notifications.off')}
                    </Button>
                </TableCell>
                <TableCell className="text-right">
                    <div className="inline-flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={props.onEdit}
                            disabled={props.pending}
                            aria-label={props.isEditing ? tr('notifications.cancelEditAria') : tr('notifications.editAria')}
                        >
                            <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={props.onTest}
                            disabled={props.pending}
                            aria-label={tr('notifications.testAria')}
                            title={tr('notifications.testTitle')}
                        >
                            <Send className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={props.onHistory}
                            disabled={props.pending}
                            aria-label={tr('notifications.historyAria')}
                            title={tr('notifications.historyTitle')}
                        >
                            <History className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={props.onDuplicate}
                            disabled={props.pending}
                            aria-label={tr('notifications.duplicateAria')}
                            title={tr('notifications.duplicateTitle')}
                        >
                            <Copy className="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={props.onRemove}
                            disabled={props.pending}
                            aria-label={tr('notifications.removeAria')}
                        >
                            <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                    </div>
                </TableCell>
            </TableRow>
            {props.isEditing ? (
                <TableRow>
                    <TableCell colSpan={6} className="bg-muted/20 p-4">
                        <EditTargetForm target={t} roots={props.roots} projects={props.projects} onSaved={props.onSaved} />
                    </TableCell>
                </TableRow>
            ) : null}
        </>
    )
}

function TargetCard(props: {
    target: NotificationTarget
    roots: Root[]
    projects: Project[]
    isEditing: boolean
    pending: boolean
    onToggle: () => void
    onRemove: () => void
    onTest: () => void
    onHistory: () => void
    onDuplicate: () => void
    onEdit: () => void
    onSaved: () => void
}) {
    const tr = useTranslations('Settings')
    const t = props.target
    return (
        <Card className="overflow-hidden p-0">
            <div className="p-4">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide">{t.kind}</span>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={props.onToggle}
                        disabled={props.pending}
                        className="ml-auto"
                    >
                        <Power className={'h-4 w-4 ' + (t.enabled ? 'text-success' : 'text-muted-foreground')} />
                        {t.enabled ? tr('notifications.on') : tr('notifications.off')}
                    </Button>
                </div>
                <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 text-xs">
                    <dt className="uppercase tracking-wide text-muted-foreground">{tr('notifications.identity')}</dt>
                    <dd className="min-w-0 break-words font-mono">{maskedIdentity(t)}</dd>
                    <dt className="uppercase tracking-wide text-muted-foreground">{tr('notifications.severity')}</dt>
                    <dd className="flex flex-wrap gap-1">
                        {t.severityFilter.map(function sev(s) {
                            return <SeverityPill key={s} variant={s} size="sm" />
                        })}
                    </dd>
                    <dt className="uppercase tracking-wide text-muted-foreground">{tr('notifications.scope')}</dt>
                    <dd>
                        <ScopeBadge target={t} roots={props.roots} projects={props.projects} />
                    </dd>
                </dl>
            </div>
            <div className="flex justify-end gap-1 border-t border-border/40 px-4 py-2">
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={props.onEdit}
                    disabled={props.pending}
                    aria-label={props.isEditing ? tr('notifications.cancelEditAria') : tr('notifications.editAria')}
                >
                    <Pencil className="h-4 w-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={props.onTest}
                    disabled={props.pending}
                    aria-label={tr('notifications.testAria')}
                    title={tr('notifications.testTitle')}
                >
                    <Send className="h-4 w-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={props.onHistory}
                    disabled={props.pending}
                    aria-label={tr('notifications.historyAria')}
                    title={tr('notifications.historyTitle')}
                >
                    <History className="h-4 w-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={props.onDuplicate}
                    disabled={props.pending}
                    aria-label={tr('notifications.duplicateAria')}
                    title={tr('notifications.duplicateTitle')}
                >
                    <Copy className="h-4 w-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={props.onRemove}
                    disabled={props.pending}
                    aria-label={tr('notifications.removeAria')}
                >
                    <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
            </div>
            {props.isEditing ? (
                <div className="border-t border-border/40 bg-muted/20 p-4">
                    <EditTargetForm target={t} roots={props.roots} projects={props.projects} onSaved={props.onSaved} />
                </div>
            ) : null}
        </Card>
    )
}

function ScopeBadge({ target, roots, projects }: { target: NotificationTarget; roots: Root[]; projects: Project[] }) {
    const t = useTranslations('Settings')
    if (target.rootIds.length === 0 && target.projectIds.length === 0) {
        return <span className="text-xs text-muted-foreground">{t('notifications.allRoots')}</span>
    }
    const rootLabels = target.rootIds.map(function pick(id) {
        const r = roots.find(function match(x) { return x.id === id })
        if (!r) return id
        return r.label || r.path
    })
    const projectLabels = target.projectIds.map(function pick(id) {
        const p = projects.find(function match(x) { return x.id === id })
        if (!p) return id
        return p.alias || p.name
    })
    const total = target.rootIds.length + target.projectIds.length
    return (
        <span className="text-xs" title={[...rootLabels, ...projectLabels].join('\n')}>
            {t('notifications.scopeCount', { count: total })}
        </span>
    )
}

function EditTargetForm({ target, roots, projects, onSaved }: { target: NotificationTarget; roots: Root[]; projects: Project[]; onSaved: () => void }) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const [enabled, setEnabled] = useState(target.enabled)
    const [filter, setFilter] = useState<Severity[]>(target.severityFilter)
    const [envFilter, setEnvFilter] = useState<DepTypeFilter>(target.envFilter)
    const [scopeMode, setScopeMode] = useState<RootScopeMode>(modeFromScope(target.rootIds, target.projectIds))
    const [selectedRootIds, setSelectedRootIds] = useState<string[]>(target.rootIds)
    const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>(target.projectIds)
    const [pending, startTransition] = useTransition()
    function toggleSeverity(sev: Severity) {
        setFilter(function next(prev) {
            if (prev.includes(sev)) return prev.filter(function notSev(s) { return s !== sev })
            return [...prev, sev]
        })
    }
    const scopeInvalid = scopeMode === 'selected' && selectedRootIds.length === 0 && selectedProjectIds.length === 0
    function submit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        if (scopeInvalid) return
        startTransition(async function persist() {
            const rootIds = scopeMode === 'all' ? [] : selectedRootIds
            const projectIds = scopeMode === 'all' ? [] : selectedProjectIds
            await updateNotificationTargetAction({
                id: target.id,
                severityFilter: filter,
                envFilter,
                enabled,
                rootIds,
                projectIds
            })
            onSaved()
        })
    }
    return (
        <form onSubmit={submit} className="space-y-4">
            <label className="flex items-center gap-2 text-sm">
                <input
                    type="checkbox"
                    checked={enabled}
                    onChange={function onChange(e) { setEnabled(e.target.checked) }}
                    className="h-4 w-4"
                />
                {t('notifications.enabled')}
            </label>
            <div className="flex flex-col gap-2">
                <Label>{t('notifications.severityFilter')}</Label>
                <SeverityFilterPills value={filter} onToggle={toggleSeverity} disabled={pending} />
            </div>
            <EnvFilterField value={envFilter} onChange={setEnvFilter} disabled={pending} />
            <RootScopeField
                id={'edit-target-' + target.id}
                roots={roots}
                projects={projects}
                mode={scopeMode}
                selectedRootIds={selectedRootIds}
                selectedProjectIds={selectedProjectIds}
                onModeChange={setScopeMode}
                onSelectedRootsChange={setSelectedRootIds}
                onSelectedProjectsChange={setSelectedProjectIds}
                disabled={pending}
            />
            <div className="flex justify-end gap-2">
                <Button type="submit" disabled={pending || scopeInvalid}>
                    {pending ? tc('saving') : t('notifications.saveChanges')}
                </Button>
            </div>
        </form>
    )
}

function maskedIdentity(t: NotificationTarget): string {
    if (t.kind === 'slack') {
        const cfg = t.config as { webhookUrl: string }
        return 'slack(' + maskTail(cfg.webhookUrl) + ')'
    }
    if (t.kind === 'telegram') {
        const cfg = t.config as { botToken: string; chatId: string }
        return 'telegram(bot=' + maskTail(cfg.botToken) + ', chat=' + cfg.chatId + ')'
    }
    const cfg = t.config as { url: string }
    return 'webhook(' + maskTail(cfg.url) + ')'
}

function maskTail(value: string): string {
    if (value.startsWith('env:')) return value
    if (value.length <= 6) return '••••'
    return '••••' + value.slice(-4)
}
