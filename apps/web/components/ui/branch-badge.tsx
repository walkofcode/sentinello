import { GitBranch } from 'lucide-react'
import { cn } from '@/lib/cn'

// The git branch a project's findings came from, recorded by the worker at scan time.
// Renders nothing when the branch is unknown: a project that is not a git checkout is a normal
// state (a plain directory of manifests), not something to flag. The branch name is its own label,
// so no translated string is needed — the icon carries the meaning and is hidden from assistive
// tech, which reads the name itself.
export function BranchBadge({ branch, className }: { branch: string | null; className?: string }) {
    if (!branch) return null
    return (
        <span
            className={cn('inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground', className)}
            title={branch}
        >
            <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{branch}</span>
        </span>
    )
}
