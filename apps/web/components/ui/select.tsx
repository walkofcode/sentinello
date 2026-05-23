import { forwardRef, type SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'

// Wrapped in a relative container so we can render our own caret with enough
// breathing room from the right border. Native <select> caret rendering ignores
// padding-right in practice, so we strip the native appearance and draw the
// chevron ourselves.
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
    { className, children, ...props },
    ref
) {
    return (
        <div className="relative inline-flex">
            <select
                ref={ref}
                className={cn(
                    'h-9 w-full appearance-none rounded-md border bg-card pl-3 pr-9 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
                    className
                )}
                {...props}
            >
                {children}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        </div>
    )
})
