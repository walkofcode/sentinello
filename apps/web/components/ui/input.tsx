import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
    { className, type, ...props },
    ref
) {
    return (
        <input
            ref={ref}
            type={type}
            className={cn(
                'flex h-9 w-full rounded-md border bg-card px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
                className
            )}
            {...props}
        />
    )
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
    { className, ...props },
    ref
) {
    return (
        <textarea
            ref={ref}
            className={cn(
                'flex min-h-[80px] w-full rounded-md border bg-card px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
                className
            )}
            {...props}
        />
    )
})

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(function Label(
    { className, ...props },
    ref
) {
    return (
        <label
            ref={ref}
            className={cn('text-sm font-medium leading-none peer-disabled:opacity-70', className)}
            {...props}
        />
    )
})
