'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/ui/empty-state'
import { AddRootDialog } from '@/components/settings/add-root-dialog'
import { ScanAutoRefresh } from '@/components/scan-auto-refresh'
import { deleteRootAction, updateRootLabelAction } from '@/lib/actions/settings'
import { requestScanForRoot } from '@/lib/actions/scan-request'

type RootRow = {
    id: string
    path: string
    label: string | null
    projectCount: number
    scanning: boolean
}

type Props = {
    roots: RootRow[]
    anyInFlight: boolean
}

export function RootList({ roots, anyInFlight }: Props) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const [pending, startTransition] = useTransition()
    const [open, setOpen] = useState(false)
    // Single-row label edit at a time, mirroring NotificationTargetList's editingId pattern.
    const [editingId, setEditingId] = useState<string | null>(null)
    const [draftLabel, setDraftLabel] = useState('')
    // Confirm-then-delete: the trash icon stages the row id, the modal commits via deleteRootAction.
    // The fixed deleteRoot in @sentinello/db cascades all projects/scans/findings/notifications under
    // the root, so an unconfirmed click would wipe a large amount of history irreversibly.
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
    const pendingRoot = pendingDeleteId && roots.find(function byId(r) { return r.id === pendingDeleteId }) || null
    function requestDelete(id: string) {
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
            await deleteRootAction(id)
            setPendingDeleteId(null)
        })
    }
    function scan(id: string) {
        startTransition(async function fire() {
            await requestScanForRoot(id)
        })
    }
    function startEdit(r: RootRow) {
        setEditingId(r.id)
        setDraftLabel(r.label || '')
    }
    function cancelEdit() {
        setEditingId(null)
        setDraftLabel('')
    }
    function saveEdit(id: string) {
        startTransition(async function persist() {
            await updateRootLabelAction(id, draftLabel)
            setEditingId(null)
            setDraftLabel('')
        })
    }
    const existingPaths = roots.map(function pick(r) { return r.path })
    return (
        <div className="space-y-4">
            <ScanAutoRefresh active={anyInFlight} />
            {roots.length === 0 ? (
                <EmptyState
                    title={t('roots.emptyTitle')}
                    description={t('roots.emptyDescription')}
                >
                    <Button onClick={function openAdd() { setOpen(true) }}>
                        <Plus className="h-4 w-4" />
                        {t('roots.addButton')}
                    </Button>
                </EmptyState>
            ) : (
                <>
                    <div className="flex justify-end">
                        <Button onClick={function openAdd() { setOpen(true) }}>
                            <Plus className="h-4 w-4" />
                            {t('roots.addButton')}
                        </Button>
                    </div>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t('roots.colPath')}</TableHead>
                                <TableHead>{t('roots.colLabel')}</TableHead>
                                <TableHead>{t('roots.colProjects')}</TableHead>
                                <TableHead className="text-right"></TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {roots.map(function row(r) {
                                const isEditing = editingId === r.id
                                const busy = r.scanning || pending
                                let scanLabel = t('roots.scanNow')
                                if (r.scanning) scanLabel = t('roots.scanning')
                                return (
                                    <TableRow key={r.id}>
                                        <TableCell className="font-mono text-xs">{r.path}</TableCell>
                                        <TableCell>
                                            {isEditing ? (
                                                <form
                                                    onSubmit={function onSubmit(e) {
                                                        e.preventDefault()
                                                        saveEdit(r.id)
                                                    }}
                                                    className="flex items-center gap-2"
                                                >
                                                    <Input
                                                        autoFocus
                                                        value={draftLabel}
                                                        onChange={function onChange(e) { setDraftLabel(e.target.value) }}
                                                        placeholder={t('roots.labelPlaceholder')}
                                                        className="h-8 w-56"
                                                        disabled={pending}
                                                    />
                                                    <Button
                                                        type="submit"
                                                        variant="ghost"
                                                        size="icon"
                                                        disabled={pending}
                                                        aria-label={t('roots.saveLabelAria')}
                                                    >
                                                        <Check className="h-4 w-4 text-success" />
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={cancelEdit}
                                                        disabled={pending}
                                                        aria-label={t('roots.cancelEditAria')}
                                                    >
                                                        <X className="h-4 w-4" />
                                                    </Button>
                                                </form>
                                            ) : (
                                                <span>{r.label || '—'}</span>
                                            )}
                                        </TableCell>
                                        <TableCell>{r.projectCount}</TableCell>
                                        <TableCell className="text-right">
                                            <div className="inline-flex items-center gap-1">
                                                {isEditing ? null : (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        onClick={function click() { startEdit(r) }}
                                                        disabled={pending}
                                                        aria-label={t('roots.editLabelAria')}
                                                        title={t('roots.renameLabel')}
                                                    >
                                                        <Pencil className="h-4 w-4" />
                                                    </Button>
                                                )}
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={function click() { scan(r.id) }}
                                                    disabled={busy}
                                                    title={t('roots.scanTitle')}
                                                >
                                                    <RefreshCw className={'h-4 w-4 ' + (busy && 'animate-spin' || '')} />
                                                    {scanLabel}
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={function click() { requestDelete(r.id) }}
                                                    disabled={pending}
                                                    aria-label={t('roots.removeAria')}
                                                >
                                                    <Trash2 className="h-4 w-4 text-destructive" />
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                )
                            })}
                        </TableBody>
                    </Table>
                </>
            )}
            <AddRootDialog
                open={open}
                onClose={function close() { setOpen(false) }}
                existingPaths={existingPaths}
            />
            <ConfirmDialog
                open={pendingRoot !== null}
                onClose={cancelDelete}
                onConfirm={confirmDelete}
                title={t('roots.deleteConfirm.title')}
                description={pendingRoot && t('roots.deleteConfirm.description', { path: pendingRoot.path, projectCount: pendingRoot.projectCount }) || ''}
                confirmLabel={t('roots.deleteConfirm.confirm')}
                cancelLabel={tc('cancel')}
                destructive
                pending={pending}
            />
        </div>
    )
}
