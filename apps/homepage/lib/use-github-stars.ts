'use client'

import { useEffect, useState } from 'react'
import { GITHUB_API_URL } from '@/lib/links'

// Pulls the real star count client-side (unauthenticated, ~60 req/hr/IP — fine for visitors). Fails
// open: on error or rate-limit it stays null and callers simply render no number, never an error.
export function useGitHubStars(): number | null {
    const [stars, setStars] = useState<number | null>(null)
    useEffect(function fetchStars() {
        let alive = true
        async function load() {
            try {
                const res = await fetch(GITHUB_API_URL, { headers: { Accept: 'application/vnd.github+json' } })
                if (!res.ok) return
                const data = await res.json()
                if (alive && typeof data.stargazers_count === 'number') setStars(data.stargazers_count)
            } catch {
                // Network/rate-limit — leave stars null.
            }
        }
        load()
        return function cleanup() { alive = false }
    }, [])
    return stars
}

export function formatStarCount(n: number): string {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k'
    return String(n)
}
