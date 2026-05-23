import { type HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                'rounded-(--radius-card) border bg-card text-card-foreground shadow-sm',
                className
            )}
            {...props}
        />
    )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn('flex flex-col gap-1.5 px-5 pt-5 pb-3', className)} {...props} />
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
    return <h3 className={cn('text-sm font-medium text-muted-foreground', className)} {...props} />
}

export function CardValue({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn('text-3xl font-semibold tracking-tight', className)} {...props} />
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn('px-5 pb-5', className)} {...props} />
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn('flex items-center px-5 pb-5 text-xs text-muted-foreground', className)} {...props} />
}
