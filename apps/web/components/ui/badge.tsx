import { type HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

const badgeVariants = cva(
    'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset uppercase tracking-wide',
    {
        variants: {
            variant: {
                default: 'bg-accent text-accent-foreground ring-border',
                outline: 'text-foreground ring-border bg-transparent',
                critical: 'bg-[color:var(--color-sev-critical)]/15 text-[color:var(--color-sev-critical)] ring-[color:var(--color-sev-critical)]/30',
                high: 'bg-[color:var(--color-sev-high)]/15 text-[color:var(--color-sev-high)] ring-[color:var(--color-sev-high)]/30',
                moderate: 'bg-[color:var(--color-sev-moderate)]/15 text-[color:var(--color-sev-moderate)] ring-[color:var(--color-sev-moderate)]/30',
                low: 'bg-[color:var(--color-sev-low)]/15 text-[color:var(--color-sev-low)] ring-[color:var(--color-sev-low)]/30',
                info: 'bg-[color:var(--color-sev-info)]/15 text-[color:var(--color-sev-info)] ring-[color:var(--color-sev-info)]/30',
                muted: 'bg-muted text-muted-foreground ring-border',
                dev: 'bg-slate-100 text-slate-700 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-600',
                // Finding-source provenance badges. osv = the OSV source; npm = the built-in npm audit.
                osv: 'bg-indigo-100 text-indigo-700 ring-indigo-300 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-800',
                npm: 'bg-amber-100 text-amber-800 ring-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800',
                // Malicious-package emphasis — a distinct threat class from CVE findings.
                malicious: 'bg-[color:var(--color-sev-critical)] text-white ring-[color:var(--color-sev-critical)]'
            }
        },
        defaultVariants: {
            variant: 'default'
        }
    }
)

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>

export function Badge({ className, variant, ...props }: BadgeProps) {
    return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
