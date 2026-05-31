import { type ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Props = {
    id?: string
    children: ReactNode
    className?: string
}

export function Section({ id, children, className }: Props) {
    return (
        <section id={id} className="scroll-mt-16">
            <div className={cn('mx-auto w-full max-w-6xl px-4 py-16 sm:py-20', className)}>{children}</div>
        </section>
    )
}
