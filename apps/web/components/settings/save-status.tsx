'use client'

import { useTranslations } from 'next-intl'

type Props = {
    pending: boolean
    saved: boolean
    error: string | null
    // Shown when nothing has been saved yet. Settings → Defaults uses it to explain that changes apply
    // immediately; the other forms have nothing to say in that state.
    idleText?: string
}

// The saving / saved / failed line every auto-saving settings form shares.
//
// Four forms grew four different answers to "did that work?" — Schedule and Defaults had an aria-live
// region, Sources had an inline error with no live region, and Advanced had nothing at all, so the
// only evidence a save had happened was a button label flickering. One component means an operator
// gets the same answer in the same place on every page, and a screen reader is told on all of them.
//
// role="alert" on the error rather than folding it into the polite region: a rejected write is not an
// incidental status update, and it must interrupt.
export function SaveStatus({ pending, saved, error, idleText }: Props) {
    const tc = useTranslations('Common')
    return (
        <div className="space-y-1">
            <div className="h-4 text-xs text-muted-foreground" aria-live="polite">
                {pending ? tc('saving') : (saved ? tc('saved') : (idleText || ''))}
            </div>
            {error ? (
                <p role="alert" className="text-xs text-[color:var(--color-sev-high)]">{error}</p>
            ) : null}
        </div>
    )
}
