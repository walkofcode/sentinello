'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

// Section ids in page order. The label for each is the section's own heading key, so the bar and the
// menu always read exactly what's printed on the page (single source of truth).
const SECTIONS: { id: string; titleKey: string }[] = [
    { id: 'how', titleKey: 'How.title' },
    { id: 'features', titleKey: 'Features.title' },
    { id: 'notifications', titleKey: 'Notifications.title' },
    { id: 'screenshots', titleKey: 'Screenshots.title' },
    { id: 'selfHost', titleKey: 'SelfHost.title' },
    { id: 'why', titleKey: 'Why.title' },
    { id: 'releaseNotes', titleKey: 'ReleaseNotes.title' },
    { id: 'roadmap', titleKey: 'Roadmap.title' },
    { id: 'whoFor', titleKey: 'WhoFor.title' }
]

// A section is "active" once its top scrolls above this line (just below the 56px sticky header).
const ACTIVATE_LINE_PX = 80

// On tall viewports the last sections can never push their tops up to ACTIVATE_LINE_PX — the page
// bottoms out first, so they'd never activate (clicking "Roadmap" wouldn't update the label). Sweep
// the line down toward the viewport bottom across the final viewport of scroll: away from the bottom
// it stays at ACTIVATE_LINE_PX (precise), and as the page bottoms out it descends so each trailing
// section crosses it in turn. Mirrors apps/web/components/layout/scroll-spy-context.tsx.
function computeReadingLine(): number {
    if (typeof window === 'undefined') return ACTIVATE_LINE_PX
    const viewport = window.innerHeight
    const maxScroll = document.documentElement.scrollHeight - viewport
    if (maxScroll <= 0) return ACTIVATE_LINE_PX
    const distanceIntoLastViewport = window.scrollY - (maxScroll - viewport)
    const progress = Math.min(Math.max(distanceIntoLastViewport / viewport, 0), 1)
    return ACTIVATE_LINE_PX + progress * (viewport - ACTIVATE_LINE_PX)
}

export function SectionMenu() {
    const t = useTranslations()
    const tNav = useTranslations('Nav')
    const [active, setActive] = useState<string>(SECTIONS[0].id)
    const [open, setOpen] = useState<boolean>(false)
    const wrapRef = useRef<HTMLDivElement>(null)
    // When the user clicks a menu item we pin the active section to their choice and stop the
    // scroll-spy from second-guessing it. On a tall monitor a clicked section often can't reach the
    // top (the page bottoms out with several sections sharing the view), so position-based spying
    // would otherwise snap the label to whichever trailing section wins. The pin is released the
    // moment the user scrolls by their own hand (wheel / touch / keyboard).
    const pinnedRef = useRef<boolean>(false)

    useEffect(function spy() {
        function recompute() {
            if (pinnedRef.current) return
            const line = computeReadingLine()
            let current = SECTIONS[0].id
            for (const s of SECTIONS) {
                const el = document.getElementById(s.id)
                if (!el) continue
                if (el.getBoundingClientRect().top - line <= 1) current = s.id
            }
            setActive(current)
        }
        function onUserScroll() {
            pinnedRef.current = false
            recompute()
        }
        recompute()
        window.addEventListener('scroll', recompute, { passive: true })
        window.addEventListener('resize', recompute)
        window.addEventListener('wheel', onUserScroll, { passive: true })
        window.addEventListener('touchmove', onUserScroll, { passive: true })
        window.addEventListener('keydown', onUserScroll)
        return function cleanup() {
            window.removeEventListener('scroll', recompute)
            window.removeEventListener('resize', recompute)
            window.removeEventListener('wheel', onUserScroll)
            window.removeEventListener('touchmove', onUserScroll)
            window.removeEventListener('keydown', onUserScroll)
        }
    }, [])

    useEffect(function bindOutside() {
        if (!open) return
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') setOpen(false)
        }
        function onClick(e: MouseEvent) {
            const target = e.target as Node | null
            if (wrapRef.current && target && !wrapRef.current.contains(target)) setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onClick)
        return function cleanup() {
            document.removeEventListener('keydown', onKey)
            document.removeEventListener('mousedown', onClick)
        }
    }, [open])

    function jump(id: string) {
        setOpen(false)
        pinnedRef.current = true
        setActive(id)
        const el = document.getElementById(id)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }

    return (
        <div ref={wrapRef} className="relative">
            <Button
                variant="ghost"
                size="sm"
                onClick={function toggle() { setOpen(function flip(p) { return !p }) }}
                aria-label={tNav('sections')}
                aria-haspopup="menu"
                aria-expanded={open}
                className="gap-1.5"
            >
                <span className="max-w-[9rem] truncate text-sm font-semibold sm:max-w-none">{t(SECTIONS.find(function f(s) { return s.id === active })?.titleKey || SECTIONS[0].titleKey)}</span>
                <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')} />
            </Button>
            {open && (
                <div role="menu" className="absolute left-0 z-40 mt-1 w-56 overflow-hidden rounded-md border bg-card p-1 shadow-lg">
                    {SECTIONS.map(function item(s) {
                        const isActive = s.id === active
                        return (
                            <a
                                key={s.id}
                                href={'#' + s.id}
                                role="menuitem"
                                onClick={function go(e) { e.preventDefault(); jump(s.id) }}
                                className={cn(
                                    'block rounded px-2 py-1.5 text-left text-sm transition-colors',
                                    isActive ? 'bg-accent font-semibold text-accent-foreground' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                                )}
                            >
                                {t(s.titleKey)}
                            </a>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
