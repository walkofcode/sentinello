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
                // Finding-source provenance badges. osv = the OSV source; npm = the built-in npm audit;
                // gemnasium = the GitLab gemnasium source (rose, distinct from amber/indigo and the severity hues).
                osv: 'bg-indigo-100 text-indigo-700 ring-indigo-300 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-800',
                npm: 'bg-amber-100 text-amber-800 ring-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800',
                gemnasium: 'bg-rose-100 text-rose-700 ring-rose-300 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-800',
                // Ecosystem/language identity badges — one hue per language so a (ecosystem, package)
                // row reads at a glance and same-named packages in two ecosystems never look identical.
                ecoJs: 'bg-yellow-100 text-yellow-800 ring-yellow-300 dark:bg-yellow-950 dark:text-yellow-300 dark:ring-yellow-800',
                ecoPy: 'bg-sky-100 text-sky-700 ring-sky-300 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-800',
                ecoGo: 'bg-cyan-100 text-cyan-700 ring-cyan-300 dark:bg-cyan-950 dark:text-cyan-300 dark:ring-cyan-800',
                ecoRust: 'bg-orange-100 text-orange-800 ring-orange-300 dark:bg-orange-950 dark:text-orange-300 dark:ring-orange-800',
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
