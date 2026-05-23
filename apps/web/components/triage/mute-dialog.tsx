'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'
import { muteAction, unmuteAction } from '@/lib/actions/mute'

type FindingIdentity = {
    scanner: string
    advisoryId: string
    packageName: string
}

type Props = {
    projectId: string
    finding?: FindingIdentity
    label?: string
    muteId?: string
    iconOnly?: boolean
}

export function MuteDialog({ projectId, finding, label, muteId, iconOnly }: Props) {
    const t = useTranslations('Triage')
    const tc = useTranslations('Common')
    const [open, setOpen] = useState(false)
    const [reason, setReason] = useState('')
    const [expiresInDays, setExpiresInDays] = useState('')
    const [pending, startTransition] = useTransition()
    const isFindingScope = Boolean(finding)
    function submit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        startTransition(async function save() {
            const expiresAt = expiresInDays ? Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000 : null
            await muteAction({
                scope: isFindingScope ? 'finding' : 'project',
                projectId,
                scanner: finding?.scanner || null,
                advisoryId: finding?.advisoryId || null,
                packageName: finding?.packageName || null,
                reason,
                expiresAt
            })
            setReason('')
            setExpiresInDays('')
            setOpen(false)
        })
    }
    function handleUnmute() {
        if (!muteId) return
        startTransition(async function lift() {
            await unmuteAction(muteId, projectId)
        })
    }
    if (muteId) {
        const unmuteLabel = label || (isFindingScope ? t('mute.unmuteFinding') : t('mute.unmuteProject'))
        if (iconOnly) {
            return (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={handleUnmute}
                    disabled={pending}
                    aria-label={unmuteLabel}
                    title={unmuteLabel}
                    className="h-8 w-8 px-0"
                >
                    <Volume2 className="h-4 w-4" />
                </Button>
            )
        }
        return (
            <Button variant="outline" size={isFindingScope ? 'sm' : 'default'} onClick={handleUnmute} disabled={pending}>
                <Volume2 className="h-4 w-4" />
                {pending ? t('mute.lifting') : unmuteLabel}
            </Button>
        )
    }
    if (!open) {
        const triggerLabel = label || (isFindingScope ? t('mute.muteFinding') : t('mute.muteProject'))
        if (iconOnly) {
            return (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={function show() { setOpen(true) }}
                    aria-label={triggerLabel}
                    title={triggerLabel}
                    className="h-8 w-8 px-0"
                >
                    <VolumeX className="h-4 w-4" />
                </Button>
            )
        }
        return (
            <Button variant="outline" size={isFindingScope ? 'sm' : 'default'} onClick={function show() { setOpen(true) }}>
                <VolumeX className="h-4 w-4" />
                {triggerLabel}
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
                    <h3 className="text-base font-semibold">
                        {isFindingScope ? t('mute.muteFinding') : t('mute.muteProject')}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {isFindingScope
                            ? t('mute.findingDescription')
                            : t('mute.projectDescription')}
                    </p>
                </div>
                {isFindingScope && finding ? (
                    <div className="rounded-md border bg-muted/30 p-3 text-xs">
                        <div>
                            <span className="text-muted-foreground">{t('mute.scannerLabel')}</span> {finding.scanner}
                        </div>
                        <div>
                            <span className="text-muted-foreground">{t('mute.advisoryLabel')}</span> {finding.advisoryId}
                        </div>
                        <div>
                            <span className="text-muted-foreground">{t('mute.packageLabel')}</span> {finding.packageName}
                        </div>
                    </div>
                ) : null}
                <div className="flex flex-col gap-1">
                    <Label htmlFor="reason">{t('mute.reasonLabel')}</Label>
                    <Textarea
                        id="reason"
                        value={reason}
                        onChange={function onChange(e) { setReason(e.target.value) }}
                        placeholder={t('mute.reasonPlaceholderFinding')}
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
                        {pending ? t('mute.muting') : t('mute.mute')}
                    </Button>
                </div>
            </form>
        </div>
    )
}

