'use client'

import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

type Props = {
    open: boolean
    onClose: () => void
    title: string
    description?: string
    children: ReactNode
    className?: string
}

export function Dialog({ open, onClose, title, description, children, className }: Props) {
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
                        aria-label="Close dialog"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
                {children}
            </div>
        </div>
    )
}
