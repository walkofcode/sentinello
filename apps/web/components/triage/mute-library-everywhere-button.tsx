'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
    if (!open) {
        const triggerLabel = (allMuted && t('muteEverywhere.allMutedTrigger')) || t('muteEverywhere.muteAllTrigger')
        return (
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
        )
    }
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4">
            <form
                onSubmit={submit}
                className="w-full max-w-md space-y-4 rounded-(--radius-card) border bg-card p-6 shadow-xl"
            >
                <div>
                    <h3 className="text-base font-semibold">{t('muteEverywhere.title')}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {t.rich('muteEverywhere.description', {
                            pkg: packageName,
                            mono: function mono(chunks) { return <span className="font-mono">{chunks}</span> }
                        })}
                    </p>
                </div>
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
                    <Label htmlFor="reason">{t('mute.reasonLabel')}</Label>
                    <Textarea
                        id="reason"
                        value={reason}
                        onChange={function onChange(e) { setReason(e.target.value) }}
                        placeholder={t('muteEverywhere.reasonPlaceholder')}
                        required
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <Label htmlFor="expires">{t('mute.autoLiftLabel')}</Label>
                    <Input
                        id="expires"
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
        </div>
    )
}
