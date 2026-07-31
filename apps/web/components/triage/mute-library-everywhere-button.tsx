'use client'

import { useId, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input, Label, Textarea } from '@/components/ui/input'
import { muteLibraryEverywhereAction, type MuteLibraryEverywhereRow } from '@/lib/actions/mute'

type Props = {
    packageName: string
    rows: MuteLibraryEverywhereRow[]
    totalRows: number
    disabled?: boolean
}

export function MuteLibraryEverywhereButton({ packageName, rows, totalRows, disabled }: Props) {
    const t = useTranslations('Triage')
    const tc = useTranslations('Common')
    const [open, setOpen] = useState(false)
    const [reason, setReason] = useState('')
    const [expiresInDays, setExpiresInDays] = useState('')
    const [pending, startTransition] = useTransition()
    const reasonId = useId()
    const expiresId = useId()
    function submit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        startTransition(async function save() {
            const expiresAt = (expiresInDays && Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000) || null
            await muteLibraryEverywhereAction({
                packageName,
                rows,
                reason,
                expiresAt
            })
            setReason('')
            setExpiresInDays('')
            setOpen(false)
        })
    }
    const unmutedCount = rows.length
    const allMuted = unmutedCount === 0
    const projectCount = new Set(rows.map(function pickProject(r) { return r.projectId })).size
    const triggerLabel = (allMuted && t('muteEverywhere.allMutedTrigger')) || t('muteEverywhere.muteAllTrigger')
    return (
        <>
            <Button
                variant="outline"
                size="sm"
                onClick={function show() { setOpen(true) }}
                disabled={disabled || allMuted}
                aria-label={triggerLabel}
                title={triggerLabel}
            >
                <VolumeX className="h-4 w-4" />
                <span>{t('muteEverywhere.muteEverywhere')}</span>
            </Button>
            <Dialog
                open={open}
                onClose={function close() { setOpen(false) }}
                title={t('muteEverywhere.title')}
                description={t.rich('muteEverywhere.description', {
                    pkg: packageName,
                    mono: function mono(chunks) { return <span className="font-mono">{chunks}</span> }
                })}
                className="max-w-md"
            >
                <form onSubmit={submit} className="space-y-4 p-6">
                    <div className="rounded-md border bg-muted/30 p-3 text-xs">
                        <div>
                            <span className="text-muted-foreground">{t('muteLibrary.packageLabel')}</span> {packageName}
                        </div>
                        <div>
                            <span className="text-muted-foreground">{t('muteLibrary.advisoriesToMuteLabel')}</span> {t('muteLibrary.countOf', { count: unmutedCount, total: totalRows })}
                        </div>
                        <div>
                            <span className="text-muted-foreground">{t('muteEverywhere.projectsAffectedLabel')}</span> {projectCount}
                        </div>
                    </div>
                    <div className="flex flex-col gap-1">
                        <Label htmlFor={reasonId}>{t('mute.reasonLabel')}</Label>
                        <Textarea
                            id={reasonId}
                            value={reason}
                            onChange={function onChange(e) { setReason(e.target.value) }}
                            placeholder={t('muteEverywhere.reasonPlaceholder')}
                            required
                            autoFocus
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <Label htmlFor={expiresId}>{t('mute.autoLiftLabel')}</Label>
                        <Input
                            id={expiresId}
                            type="number"
                            min={1}
                            value={expiresInDays}
                            onChange={function onChange(e) { setExpiresInDays(e.target.value) }}
                            placeholder={t('mute.autoLiftPlaceholder')}
                        />
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={function close() { setOpen(false) }}>
                            {tc('cancel')}
                        </Button>
                        <Button type="submit" disabled={pending || reason.trim().length === 0}>
                            {(pending && t('mute.muting')) || t('muteLibrary.muteCount', { count: unmutedCount })}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </>
    )
}
