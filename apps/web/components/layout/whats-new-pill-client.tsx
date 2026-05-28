'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Sparkles, X } from 'lucide-react'

// Per-version dismissal: storing the seen version means the pill reappears automatically
// when a newer curated version ships. Mirrors UpdateBannerClient's storage approach.
const STORAGE_KEY = 'sentinello-whatsnew-seen-version'

type ReleaseCopy = {
    title: string
    items: string[]
}

type Props = {
    version: string
}

export function WhatsNewPillClient({ version }: Props) {
    const t = useTranslations('WhatsNew')
    // Start hidden so SSR + first client render emit nothing — no flash for users who
    // already dismissed this version.
    const [show, setShow] = useState(false)
    const [open, setOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(function readSeen() {
        try {
            const stored = window.localStorage.getItem(STORAGE_KEY)
            if (stored !== version) setShow(true)
        } catch {
            // localStorage unavailable — show the pill; it just won't stay dismissed
            setShow(true)
        }
    }, [version])

    useEffect(function bindCloseHandlers() {
        if (!open) return
        function onPointerDown(event: PointerEvent) {
            const target = event.target as Node | null
            if (containerRef.current && target && !containerRef.current.contains(target)) {
                setOpen(false)
            }
        }
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return function cleanup() {
            document.removeEventListener('pointerdown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
        }
    }, [open])

    function toggleOpen() {
        setOpen(function flip(prev) { return !prev })
    }

    function closePopover() {
        setOpen(false)
    }

    function handleDismiss() {
        try {
            window.localStorage.setItem(STORAGE_KEY, version)
        } catch {
            // best-effort persistence; matches FontSizeProvider's pattern
        }
        setOpen(false)
        setShow(false)
    }

    if (!show) return null

    // Version keys contain dots; read the whole releases object and index by version.
    const releases = t.raw('releases') as Record<string, ReleaseCopy>
    const copy = releases[version]
    if (!copy) return null

    return (
        <div ref={containerRef} className="relative">
            <button
                type="button"
                onClick={toggleOpen}
                aria-haspopup="menu"
                aria-expanded={open}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
            >
                <Sparkles aria-hidden="true" className="size-4" />
                <span className="hidden sm:inline">{t('pillLabel')}</span>
            </button>
            {open ? (
                <div
                    role="menu"
                    className="absolute right-0 top-full z-40 mt-2 w-72 rounded-md border bg-card p-3 shadow-md"
                >
                    <div className="mb-2 flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold">{t('popoverHeading', { version })}</h3>
                        <button
                            type="button"
                            onClick={handleDismiss}
                            aria-label={t('dismiss')}
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                            <X aria-hidden="true" className="size-4" />
                        </button>
                    </div>
                    <ul className="space-y-1.5 text-sm text-muted-foreground">
                        {copy.items.map(function renderItem(item, index) {
                            return (
                                <li key={index} className="flex gap-2">
                                    <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 rounded-full bg-emerald-500" />
                                    <span>{item}</span>
                                </li>
                            )
                        })}
                    </ul>
                    <Link
                        href="/settings/whats-new"
                        onClick={closePopover}
                        className="mt-3 inline-block text-sm font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300"
                    >
                        {t('seeFullHistory')} →
                    </Link>
                </div>
            ) : null}
        </div>
    )
}