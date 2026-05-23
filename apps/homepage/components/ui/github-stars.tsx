'use client'

import { Star } from 'lucide-react'
import { GITHUB_URL } from '@/lib/links'
import { formatStarCount, useGitHubStars } from '@/lib/use-github-stars'
import { GithubIcon } from './github-icon'

type Props = {
    label: string
}

export function GitHubStars({ label }: Props) {
    const stars = useGitHubStars()
    return (
        <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md border bg-transparent px-7 text-base font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
        >
            <GithubIcon className="h-5 w-5" />
            <span>{label}</span>
            {stars !== null && (
                <span className="inline-flex items-center gap-1 border-l pl-2 text-muted-foreground">
                    <Star className="h-4 w-4 fill-warning text-warning" />
                    {formatStarCount(stars)}
                </span>
            )}
        </a>
    )
}
