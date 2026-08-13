'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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
    const titleId = useId()
    // onClose is read through a ref so it can stay OUT of the bindKeys dependency array below. Every
    // call site passes a freshly-declared inline function, so depending on it re-ran that effect on
    // every render — and since its cleanup restores focus to the opener, each keystroke inside the
    // dialog tore the effect down and yanked focus back to the trigger button. Typing was limited to
    // one character. Synced in an effect rather than during render: writing a ref while rendering is
    // what react-hooks/refs forbids, and the Escape handler reads `.current` at event time anyway, so
    // it never sees a stale callback.
    const onCloseRef = useRef(onClose)
    useEffect(function trackOnClose() {
        onCloseRef.current = onClose
    })

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
            if (e.key === 'Escape') onCloseRef.current()
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
    }, [open])
    if (!open) return null
    // Rendered into document.body rather than in place. A dialog opened from a table row is otherwise a
    // DOM descendant of that row's cell, and `<TableCell className="text-right">` inherits straight
    // through the fixed positioning — which is what right-aligned every heading and label inside the
    // mute-finding dialog while the same dialog opened from the page header looked fine. Portalling is
    // already how every other floating surface here escapes its ancestors (dropdown.tsx,
    // dep-path-popover.tsx, export-advisory-button.tsx); this one had been the exception.
    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 text-left backdrop-blur-sm"
            onClick={onClose}
            role="presentation"
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className={cn(
                    'relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-(--radius-card) border bg-card shadow-xl',
                    className
                )}
                onClick={function stop(e) { e.stopPropagation() }}
            >
                <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
                    {/* min-w-0 is load-bearing: a flex item's default min-width:auto floors it at its
                        content's intrinsic size, so a long title or description pushed this block past
                        the panel edge and the panel's overflow-hidden clipped it instead of wrapping. */}
                    <div className="min-w-0 flex-1">
                        <h2 id={titleId} className="text-base font-semibold break-words">{title}</h2>
                        {description ? (
                            <p className="mt-1 text-xs text-muted-foreground break-words">{description}</p>
                        ) : null}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                        aria-label={t('close')}
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                {children}
            </div>
        </div>,
        document.body
    )
}
