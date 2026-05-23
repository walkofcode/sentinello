'use client'

import { Star } from 'lucide-react'
import { GITHUB_URL } from '@/lib/links'
import { formatStarCount, useGitHubStars } from '@/lib/use-github-stars'
import { GithubIcon } from './github-icon'
import { cn } from '@/lib/cn'

type Props = {
    label: string
    className?: string
    onClick?: () => void
}

// Compact header link: GitHub icon + live star count. Fails open — no count until the API responds.
export function GitHubStarsLink({ label, className, onClick }: Props) {
    const stars = useGitHubStars()
    return (
        <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClick}
            aria-label={label}
            className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:px-3',
                className
            )}
        >
            <GithubIcon className="h-4 w-4" />
            <span className="hidden sm:inline">{label}</span>
            {stars !== null && (
                <span className="inline-flex items-center gap-0.5 text-foreground/80">
                    <Star className="h-3.5 w-3.5 fill-warning text-warning" />
                    {formatStarCount(stars)}
                </span>
            )}
        </a>
    )
}
