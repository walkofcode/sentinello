import { type ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

const buttonVariants = cva(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50',
    {
        variants: {
            variant: {
                default: 'bg-primary text-primary-foreground hover:opacity-90',
                outline: 'border bg-transparent hover:bg-accent hover:text-accent-foreground',
                ghost: 'hover:bg-accent hover:text-accent-foreground',
                destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
                link: 'text-primary hover:opacity-80'
            },
            size: {
                default: 'h-9 px-4 py-2',
                sm: 'h-8 px-3 text-xs',
                lg: 'h-10 px-6',
                icon: 'h-9 w-9'
            }
        },
        defaultVariants: {
            variant: 'default',
            size: 'default'
        }
    }
)

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>

// React 19 passes `ref` through as an ordinary prop, so this needs no forwardRef wrapper.
// ComponentProps<'button'> already includes it, and the spread carries it to the DOM node.
export function Button({ className, variant, size, ...props }: ButtonProps) {
    return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
