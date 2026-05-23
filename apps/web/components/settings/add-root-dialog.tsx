'use client'

import { useEffect, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowUp, ChevronRight, Folder, Home, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/input'
import {
    listDirectoryAction,
    upsertRootAction,
    type DirectoryListing
} from '@/lib/actions/settings'
import { requestScanForRoot } from '@/lib/actions/scan-request'

type Props = {
    open: boolean
    onClose: () => void
    existingPaths: string[]
}

export function AddRootDialog({ open, onClose, existingPaths }: Props) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const [listing, setListing] = useState<DirectoryListing | null>(null)
    const [pathDraft, setPathDraft] = useState('')
    const [label, setLabel] = useState('')
    const [showHidden, setShowHidden] = useState(false)
    const [loading, startLoading] = useTransition()
    const [pending, startPending] = useTransition()
    const [error, setError] = useState<string | null>(null)
    useEffect(function bootstrap() {
        if (!open) return
        setError(null)
        navigate('')
    }, [open])
    function navigate(target: string) {
        startLoading(async function load() {
            const next = await listDirectoryAction(target, showHidden)
            setListing(next)
            setPathDraft(next.path)
        })
    }
    function toggleHidden() {
        const next = !showHidden
        setShowHidden(next)
        if (listing) {
            startLoading(async function load() {
                const updated = await listDirectoryAction(listing.path, next)
                setListing(updated)
            })
        }
    }
    function submit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        if (!listing) return
        if (existingPaths.includes(listing.path)) {
            setError(t('roots.dialog.alreadyConfigured'))
            return
        }
        setError(null)
        startPending(async function persist() {
            const result = await upsertRootAction(listing.path, label)
            if (result.isNew) {
                await requestScanForRoot(result.id)
            }
            setLabel('')
            onClose()
        })
    }
    const segments = listing ? splitPath(listing.path) : []
    const alreadyAdded = listing ? existingPaths.includes(listing.path) : false
    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={t('roots.dialog.title')}
            description={t('roots.dialog.description')}
        >
            <form onSubmit={submit} className="flex flex-1 flex-col overflow-hidden">
                <div className="flex flex-col gap-3 border-b px-6 py-4">
                    <div className="flex items-center gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={function home() { navigate('') }}
                            disabled={loading}
                            aria-label={t('roots.dialog.homeAria')}
                            title={t('roots.dialog.home')}
                        >
                            <Home className="h-4 w-4" />
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={function up() { if (listing?.parent) navigate(listing.parent) }}
                            disabled={loading || !listing?.parent}
                            aria-label={t('roots.dialog.parentAria')}
                            title={t('roots.dialog.parent')}
                        >
                            <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Input
                            value={pathDraft}
                            onChange={function onChange(e) { setPathDraft(e.target.value) }}
                            onKeyDown={function onKey(e) {
                                if (e.key === 'Enter') {
                                    e.preventDefault()
                                    navigate(pathDraft)
                                }
                            }}
                            placeholder="/Users/me/code"
                            className="font-mono text-xs"
                        />
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={function go() { navigate(pathDraft) }}
                            disabled={loading}
                        >
                            {t('roots.dialog.go')}
                        </Button>
                    </div>
                    {segments.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                            {segments.map(function seg(s, i) {
                                const isLast = i === segments.length - 1
                                return (
                                    <span key={s.path} className="inline-flex items-center gap-1">
                                        <button
                                            type="button"
                                            onClick={function nav() { navigate(s.path) }}
                                            className={
                                                'rounded px-1.5 py-0.5 font-mono transition-colors ' +
                                                (isLast
                                                    ? 'bg-accent text-accent-foreground'
                                                    : 'hover:bg-accent hover:text-accent-foreground')
                                            }
                                        >
                                            {s.label}
                                        </button>
                                        {!isLast ? <ChevronRight className="h-3 w-3 opacity-60" /> : null}
                                    </span>
                                )
                            })}
                        </div>
                    ) : null}
                </div>
                <div className="min-h-[280px] flex-1 overflow-y-auto px-2 py-2">
                    {loading && !listing ? (
                        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                            <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> {tc('loading')}
                        </div>
                    ) : null}
                    {listing?.error ? (
                        <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
                            {listing.error}
                        </div>
                    ) : null}
                    {listing && !listing.error && listing.entries.length === 0 ? (
                        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                            {t('roots.dialog.noSubdirectories')}
                        </div>
                    ) : null}
                    {listing && !listing.error && listing.entries.length > 0 ? (
                        <ul className="flex flex-col">
                            {listing.entries.map(function entry(d) {
                                return (
                                    <li key={d.path}>
                                        <button
                                            type="button"
                                            onClick={function nav() { navigate(d.path) }}
                                            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                                        >
                                            <Folder className="h-4 w-4 text-muted-foreground" />
                                            <span className="font-mono text-xs">{d.name}</span>
                                        </button>
                                    </li>
                                )
                            })}
                        </ul>
                    ) : null}
                </div>
                <div className="flex flex-col gap-3 border-t bg-muted/30 px-6 py-4">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                            type="checkbox"
                            checked={showHidden}
                            onChange={toggleHidden}
                            className="h-3 w-3"
                        />
                        {t('roots.dialog.showHidden')}
                    </label>
                    <div className="flex flex-col gap-1">
                        <Label htmlFor="add-root-label">{t('roots.dialog.labelOptional')}</Label>
                        <Input
                            id="add-root-label"
                            value={label}
                            onChange={function onChange(e) { setLabel(e.target.value) }}
                            placeholder="Acme"
                        />
                    </div>
                    {alreadyAdded ? (
                        <p className="text-xs text-muted-foreground">{t('roots.dialog.alreadyConfigured')}</p>
                    ) : null}
                    {error ? (
                        <p className="text-xs text-destructive">{error}</p>
                    ) : null}
                    <div className="flex items-center justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                            {tc('cancel')}
                        </Button>
                        <Button
                            type="submit"
                            disabled={pending || loading || !listing || !!listing.error || alreadyAdded}
                        >
                            <Plus className="h-4 w-4" />
                            {pending ? t('roots.dialog.adding') : t('roots.dialog.addFolder')}
                        </Button>
                    </div>
                </div>
            </form>
        </Dialog>
    )
}

function splitPath(p: string): { label: string; path: string }[] {
    if (p === '/') return [{ label: '/', path: '/' }]
    const parts = p.split('/').filter(function nonEmpty(s) { return s.length > 0 })
    const segments: { label: string; path: string }[] = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of parts) {
        acc = acc + '/' + part
        segments.push({ label: part, path: acc })
    }
    return segments
}
