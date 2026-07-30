'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

type Props = {
    open: boolean
    onClose: () => void
    title: string
    // ReactNode rather than string because the mute-library dialogs pass t.rich(...), which returns a
    // node. Every other call site passes a plain string and is unaffected.
    description?: ReactNode
    children: ReactNode
    className?: string
}

export function Dialog({ open, onClose, title, description, children, className }: Props) {
    const t = useTranslations('Common')
    const openerRef = useRef<HTMLElement | null>(null)

    // Tracks the last thing focused OUTSIDE any dialog, so closing can hand focus back to it. Without
    // the restore, focus falls to <body> on unmount and a keyboard user resumes tabbing from the top
    // of the page, having lost the very control they opened the dialog with.
    //
    // Two non-obvious things, both learned the hard way:
    //
    // It cannot be a `document.activeElement` read when `open` flips. Effects run after commit, and
    // the autoFocus on the first field inside the dialog has already moved focus by then — so the
    // "opener" captured is the dialog's own textarea, and closing restores focus to a node that no
    // longer exists.
    //
    // And the "is it inside the dialog" test has to walk the DOM rather than consult a ref on the
    // panel. autoFocus is applied while the subtree is being inserted, which is BEFORE React attaches
    // refs — so a panelRef check is still null at the one moment it needs to be set. The ancestor is
    // already in the document by then, so closest() sees it.
    useEffect(function trackOpener() {
        function remember(e: FocusEvent) {
            const el = e.target
            if (!(el instanceof HTMLElement)) return
            if (el.closest('[role="dialog"]')) return
            openerRef.current = el
        }
        document.addEventListener('focusin', remember)
        return function cleanup() {
            document.removeEventListener('focusin', remember)
        }
    }, [])

    useEffect(function bindKeys() {
        if (!open) return
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('keydown', onKey)
        const prevOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return function cleanup() {
            document.removeEventListener('keydown', onKey)
            document.body.style.overflow = prevOverflow
            const opener = openerRef.current
            if (opener && document.contains(opener)) opener.focus()
        }
    }, [open, onClose])
    if (!open) return null
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onClick={onClose}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className={cn(
                    'relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-(--radius-card) border bg-card shadow-xl',
                    className
                )}
                onClick={function stop(e) { e.stopPropagation() }}
            >
                <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
                    <div>
                        <h2 className="text-base font-semibold">{title}</h2>
                        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                        aria-label={t('close')}
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                {children}
            </div>
        </div>
    )
}
