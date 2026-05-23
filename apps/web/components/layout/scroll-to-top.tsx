'use client'

import { useLayoutEffect } from 'react'

// Force-jump to (0, 0) on mount. Used by detail pages so navigation into a project/library
// lands at the top regardless of the previous scroll position. Uses the positional form of
// scrollTo so it bypasses the html `scroll-behavior: smooth` rule and lands instantly.
export function ScrollToTop() {
    useLayoutEffect(function jump() {
        window.scrollTo(0, 0)
    }, [])
    return null
}
