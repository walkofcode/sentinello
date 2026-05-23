'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export type ScrollSpySection = 'overview' | 'projects' | 'libraries'

type ScrollSpyContextValue = {
    activeSection: ScrollSpySection | null
    registerTarget: (id: ScrollSpySection, element: HTMLElement) => () => void
}

const ScrollSpyContext = createContext<ScrollSpyContextValue | null>(null)

const TITLE_BY_SECTION: Record<ScrollSpySection, string> = {
    overview: 'Sentinello · Overview',
    projects: 'Sentinello · Projects',
    libraries: 'Sentinello · Libraries'
}

// Matches the h-14 (56px) sticky top-nav. Used as the top boundary of the IntersectionObserver
// trigger zone so callbacks fire as a section clears the header.
const HEADER_OFFSET_PX = 56

// Where a navigated-to section's top comes to rest, and the line a section's top must cross to be
// "active". Set a comfortable gap below the 56px header (not flush against it) so titles aren't
// jammed under the bar. Shared by SpyTarget's scroll-margin and the scroll-spy below so the two
// never drift: a clicked section both lands with breathing room and highlights immediately.
const SECTION_TOP_OFFSET_PX = 96

// A section normally activates once its top slides up to SECTION_TOP_OFFSET_PX. But the last
// sections (e.g. projects + libraries, when both are short) can never push their tops that high —
// the page bottoms out first, so they'd never activate. To fix this we sweep the activation line
// down from that offset toward the viewport bottom across the final viewport of scroll: away from
// the bottom the line stays at the offset (precise behavior), and as the page bottoms out the line
// descends so each trailing section crosses it in turn.
function computeReadingLine(): number {
    if (typeof window === 'undefined') return SECTION_TOP_OFFSET_PX
    const viewport = window.innerHeight
    const maxScroll = document.documentElement.scrollHeight - viewport
    if (maxScroll <= 0) return SECTION_TOP_OFFSET_PX
    const distanceIntoLastViewport = window.scrollY - (maxScroll - viewport)
    const progress = Math.min(Math.max(distanceIntoLastViewport / viewport, 0), 1)
    return SECTION_TOP_OFFSET_PX + progress * (viewport - SECTION_TOP_OFFSET_PX)
}

export function ScrollSpyProvider({ children }: { children: ReactNode }) {
    const [activeSection, setActiveSection] = useState<ScrollSpySection | null>(null)
    const targetsRef = useRef<Map<ScrollSpySection, HTMLElement>>(new Map())
    const observerRef = useRef<IntersectionObserver | null>(null)

    const recompute = useCallback(function compute() {
        const targets = targetsRef.current
        if (targets.size === 0) {
            setActiveSection(null)
            return
        }
        const readingLine = computeReadingLine()
        let bestId: ScrollSpySection | null = null
        let bestTop = Number.NEGATIVE_INFINITY
        let firstId: ScrollSpySection | null = null
        let firstTop = Number.POSITIVE_INFINITY
        targets.forEach(function each(element, id) {
            const top = element.getBoundingClientRect().top
            if (top - readingLine <= 1) {
                if (bestId === null || top > bestTop) {
                    bestId = id
                    bestTop = top
                }
            }
            if (top < firstTop) {
                firstTop = top
                firstId = id
            }
        })
        const nextId = bestId || firstId
        if (nextId) setActiveSection(nextId)
    }, [])

    const registerTarget = useCallback(function register(id: ScrollSpySection, element: HTMLElement) {
        targetsRef.current.set(id, element)
        const observer = observerRef.current
        if (observer) observer.observe(element)
        if (typeof window !== 'undefined') {
            window.requestAnimationFrame(function tick() {
                recompute()
            })
        }
        return function unregister() {
            targetsRef.current.delete(id)
            const o = observerRef.current
            if (o) o.unobserve(element)
            if (targetsRef.current.size === 0) setActiveSection(null)
        }
    }, [recompute])

    useEffect(function setupObserver() {
        const observer = new IntersectionObserver(function onIntersect() {
            recompute()
        }, {
            rootMargin: '-' + HEADER_OFFSET_PX + 'px 0px -60% 0px',
            threshold: [0, 0.25, 0.5, 0.75, 1]
        })
        observerRef.current = observer
        targetsRef.current.forEach(function each(element) {
            observer.observe(element)
        })
        function onScroll() {
            recompute()
        }
        window.addEventListener('scroll', onScroll, { passive: true })
        recompute()
        return function cleanup() {
            observer.disconnect()
            observerRef.current = null
            window.removeEventListener('scroll', onScroll)
        }
    }, [recompute])

    useEffect(function syncTitle() {
        if (!activeSection) return
        document.title = TITLE_BY_SECTION[activeSection]
    }, [activeSection])

    const value = useMemo<ScrollSpyContextValue>(function build() {
        return { activeSection, registerTarget }
    }, [activeSection, registerTarget])

    return <ScrollSpyContext.Provider value={value}>{children}</ScrollSpyContext.Provider>
}

export function useScrollSpy(): ScrollSpyContextValue {
    const ctx = useContext(ScrollSpyContext)
    if (ctx) return ctx
    return {
        activeSection: null,
        registerTarget: function noop() {
            return function noopUnregister() {}
        }
    }
}

export function SpyTarget({ id, children }: { id: ScrollSpySection; children: ReactNode }) {
    const { registerTarget } = useScrollSpy()
    const ref = useRef<HTMLElement | null>(null)
    useEffect(function attach() {
        const el = ref.current
        if (!el) return
        return registerTarget(id, el)
    }, [id, registerTarget])
    return (
        <section id={id} ref={ref} className="space-y-6" style={{ scrollMarginTop: SECTION_TOP_OFFSET_PX }}>
            {children}
        </section>
    )
}
