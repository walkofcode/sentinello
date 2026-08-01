import { type ComponentProps } from 'react'
import { cn } from '@/lib/cn'

// React 19 passes `ref` through as an ordinary prop, so these need no forwardRef wrapper.
// ComponentProps<'input'> already includes it, and the spread carries it to the DOM node.
export function Input({ className, ...props }: ComponentProps<'input'>) {
    return (
        <input
            className={cn(
                'flex h-9 w-full rounded-md border bg-card px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
                className
            )}
            {...props}
        />
    )
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
    return (
        <textarea
            className={cn(
                'flex min-h-[80px] w-full rounded-md border bg-card px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
                className
            )}
            {...props}
        />
    )
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
    return <label className={cn('text-sm font-medium leading-none peer-disabled:opacity-70', className)} {...props} />
}
