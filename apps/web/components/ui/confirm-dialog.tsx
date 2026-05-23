'use client'

import { type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'

type Props = {
    open: boolean
    onClose: () => void
    onConfirm: () => void
    title: string
    description: ReactNode
    confirmLabel: string
    cancelLabel: string
    destructive?: boolean
    pending?: boolean
}

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel, cancelLabel, destructive, pending }: Props) {
    return (
        <Dialog open={open} onClose={onClose} title={title} className="max-w-md">
            <div className="px-6 py-4 text-sm text-muted-foreground">{description}</div>
            <div className="flex justify-end gap-2 border-t px-6 py-4">
                <Button variant="outline" onClick={onClose} disabled={pending}>{cancelLabel}</Button>
                <Button
                    variant={destructive && 'destructive' || 'default'}
                    onClick={onConfirm}
                    disabled={pending}
                    autoFocus
                >
                    {confirmLabel}
                </Button>
            </div>
        </Dialog>
    )
}
