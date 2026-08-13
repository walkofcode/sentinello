'use client'

import { useId, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Volume2, VolumeX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input, Label, Textarea } from '@/components/ui/input'
import { muteAction, muteLibraryAction, unmuteAction, unmuteManyAction } from '@/lib/actions/mute'

type FindingIdentity = {
    // Persisted mute identity (issue-016): `source` + `ecosystem` are what gets written; `scanner` is
    // provenance/display only.
    source: string
    ecosystem: string
    scanner: string
    advisoryId: string
    packageName: string
}

// A merged finding row stands in for several underlying (source, ecosystem, advisoryId) identities on
// one package. Muting it mutes all of them at once; muteIds is non-empty only when every identity is
// already muted (i.e. the row reads as muted and the control flips to unmute).
type MergedMuteTarget = {
    packageName: string
    advisories: { source: string; ecosystem: string; scanner: string; advisoryId: string }[]
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
    // What is about to be silenced, for the dialog title — the project's display name for project scope.
    // Finding scope derives it from the package name and needs nothing passed.
    targetLabel?: string
}

export function MuteDialog({ projectId, finding, merged, label, muteId, iconOnly, iconSize = 'sm', targetLabel }: Props) {
    const t = useTranslations('Triage')
    const tc = useTranslations('Common')
    const [open, setOpen] = useState(false)
    const [reason, setReason] = useState('')
    const [expiresInDays, setExpiresInDays] = useState('')
    const [pending, startTransition] = useTransition()
    // Generated rather than the literal "reason"/"expires" these three mute components all used to
    // hard-code. Only one is ever open at a time so the collision was latent, but duplicate ids are
    // invalid HTML and make every label ambiguous the moment that stops being true.
    const reasonId = useId()
    const expiresId = useId()
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
                    source: finding?.source || null,
                    ecosystem: finding?.ecosystem || null,
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
    const triggerLabel = label || (isFindingScope ? t('mute.muteFinding') : t('mute.muteProject'))
    // A generic "Mute project" gives no way to tell what you are about to silence — especially from a
    // table where every row's control carries the same words. Name the target whenever we know it.
    const targetName = targetLabel || merged?.packageName || finding?.packageName || ''
    let dialogTitle = isFindingScope ? t('mute.muteFinding') : t('mute.muteProject')
    if (targetName) {
        dialogTitle = isFindingScope
            ? t('mute.muteFindingNamed', { name: targetName })
            : t('mute.muteProjectNamed', { name: targetName })
    }
    return (
        <>
            {iconOnly ? (
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
            ) : (
                <Button variant="outline" size={isFindingScope ? 'sm' : 'default'} onClick={function show() { setOpen(true) }}>
                    <VolumeX className="h-4 w-4" />
                    {triggerLabel}
                </Button>
            )}
            <Dialog
                open={open}
                onClose={function close() { setOpen(false) }}
                title={dialogTitle}
                description={isFindingScope ? t('mute.findingDescription') : t('mute.projectDescription')}
                className="max-w-md"
            >
                <form onSubmit={submit} className="space-y-4 p-6">
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
                        <Label htmlFor={reasonId}>{t('mute.reasonLabel')}</Label>
                        <Textarea
                            id={reasonId}
                            value={reason}
                            onChange={function onChange(e) { setReason(e.target.value) }}
                            placeholder={t('mute.reasonPlaceholderFinding')}
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
                            {pending ? t('mute.muting') : t('mute.mute')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </>
    )
}
