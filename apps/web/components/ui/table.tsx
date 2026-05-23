import { type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
    return (
        <div className="w-full overflow-x-auto rounded-(--radius-card) border bg-card">
            <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
        </div>
    )
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
    return <thead className={cn('text-muted-foreground border-b', className)} {...props} />
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
    return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
    return <tr className={cn('border-b transition-colors hover:bg-muted/50', className)} {...props} />
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
    return (
        <th
            className={cn(
                'h-10 px-3 text-left align-middle font-medium text-xs uppercase tracking-wide whitespace-nowrap',
                className
            )}
            {...props}
        />
    )
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
    return <td className={cn('px-3 py-3 align-middle', className)} {...props} />
}
