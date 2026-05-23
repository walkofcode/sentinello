import { type ReactNode } from 'react'

type Props = {
    title: string
    description?: string
    children?: ReactNode
}

export function EmptyState({ title, description, children }: Props) {
    return (
        <div className="flex flex-col items-center justify-center rounded-(--radius-card) border border-dashed bg-card/50 px-6 py-16 text-center">
            <p className="text-base font-medium">{title}</p>
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
            {children ? <div className="mt-4">{children}</div> : null}
        </div>
    )
}
