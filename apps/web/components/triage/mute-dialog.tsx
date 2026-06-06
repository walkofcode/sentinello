'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'
import { muteAction, muteLibraryAction, unmuteAction, unmuteManyAction } from '@/lib/actions/mute'

type FindingIdentity = {
    scanner: string
    advisoryId: string
    packageName: string
}

// A merged finding row stands in for several underlying (scanner, advisoryId) identities on one
// package. Muting it mutes all of them at once; muteIds is non-empty only when every identity is
// already muted (i.e. the row reads as muted and the control flips to unmute).
type MergedMuteTarget = {
    packageName: string
    advisories: { scanner: string; advisoryId: string }[]
    muteIds: string[]
}

type Props = {
    projectId: string
    finding?: FindingIdentity
    merged?: MergedMuteTarget
    label?: string
    muteId?: string
    iconOnly?: boolean
    iconSize?: 'sm' | 'md'
}

export function MuteDialog({ projectId, finding, merged, label, muteId, iconOnly, iconSize = 'sm' }: Props) {
    const t = useTranslations('Triage')
    const tc = useTranslations('Common')
    const [open, setOpen] = useState(false)
    const [reason, setReason] = useState('')
    const [expiresInDays, setExpiresInDays] = useState('')
    const [pending, startTransition] = useTransition()
    const isMergedScope = Boolean(merged)
    const isFindingScope = Boolean(finding) || isMergedScope
    const showUnmute = isMergedScope ? Boolean(merged && merged.muteIds.length > 0) : Boolean(muteId)
    const sources = merged ? [...new Set(merged.advisories.map(function pick(a) { return a.scanner }))].join(', ') : ''
    function submit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        startTransition(async function save() {
            const expiresAt = expiresInDays ? Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000 : null
            if (merged) {
                await muteLibraryAction({
                    projectId,
                    packageName: merged.packageName,
                    advisories: merged.advisories,
                    reason,
                    expiresAt
                })
            } else {
                await muteAction({
                    scope: finding ? 'finding' : 'project',
                    projectId,
                    scanner: finding?.scanner || null,
                    advisoryId: finding?.advisoryId || null,
                    packageName: finding?.packageName || null,
                    reason,
                    expiresAt
                })
            }
            setReason('')
            setExpiresInDays('')
            setOpen(false)
        })
    }
    function handleUnmute() {
        startTransition(async function lift() {
            if (merged) {
                await unmuteManyAction(merged.muteIds, projectId)
            } else if (muteId) {
                await unmuteAction(muteId, projectId)
            }
        })
    }
    if (showUnmute) {
        const unmuteLabel = label || (isFindingScope ? t('mute.unmuteFinding') : t('mute.unmuteProject'))
        if (iconOnly) {
            return (
                <Button
                    variant="outline"
                    size={iconSize === 'md' ? 'icon' : 'sm'}
                    onClick={handleUnmute}
                    disabled={pending}
                    aria-label={unmuteLabel}
                    title={unmuteLabel}
                    className={iconSize === 'md' ? undefined : 'h-8 w-8 px-0'}
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
                    size={iconSize === 'md' ? 'icon' : 'sm'}
                    onClick={function show() { setOpen(true) }}
                    aria-label={triggerLabel}
                    title={triggerLabel}
                    className={iconSize === 'md' ? undefined : 'h-8 w-8 px-0'}
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
                {merged ? (
                    <div className="rounded-md border bg-muted/30 p-3 text-xs">
                        <div>
                            <span className="text-muted-foreground">{t('mute.packageLabel')}</span> {merged.packageName}
                        </div>
                        <div>
                            <span className="text-muted-foreground">{t('mute.scannerLabel')}</span> {sources}
                        </div>
                        <div>
                            <span className="text-muted-foreground">{t('mute.advisoryLabel')}</span> {merged.advisories.length}
                        </div>
                    </div>
                ) : finding ? (
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
