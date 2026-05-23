'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowUpCircle, X } from 'lucide-react'

// Per-version dismissal: storing the dismissed `latest` here means the banner
// reappears automatically when a *newer* version is published. Matches how
// GitHub / npm handle update notices.
const STORAGE_KEY = 'sentinello-update-banner-dismissed-version'

type Props = {
    version: string
    releaseUrl: string
}

export function UpdateBannerClient({ version, releaseUrl }: Props) {
    // Start hidden so SSR + the first client render both emit nothing — no
    // flash-of-banner-then-hide for users who already dismissed this version.
    const [show, setShow] = useState(false)
    const t = useTranslations('UpdateBanner')

    useEffect(function readDismissed() {
        try {
            const stored = window.localStorage.getItem(STORAGE_KEY)
            if (stored !== version) setShow(true)
        } catch {
            // localStorage unavailable — show the banner; it just won't stay dismissed
            setShow(true)
        }
    }, [version])

    function handleDismiss() {
        try {
            window.localStorage.setItem(STORAGE_KEY, version)
        } catch {
            // Best-effort persistence; matches FontSizeProvider's pattern
        }
        setShow(false)
    }

    if (!show) return null

    return (
        <div className="mx-auto w-full max-w-7xl px-4 pt-4">
            <div
                role="status"
                className="flex items-center gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300"
            >
                <ArrowUpCircle aria-hidden="true" className="size-4 shrink-0" />
                <span className="flex-1">
                    {t('title', { version })}{' '}
                    <a
                        href={releaseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium underline-offset-2 hover:underline"
                    >
                        {t('cta')} ↗
                    </a>
                </span>
                <button
                    type="button"
                    onClick={handleDismiss}
                    aria-label={t('dismiss')}
                    className="rounded p-1 text-emerald-700/70 transition-colors hover:bg-emerald-500/20 hover:text-emerald-700 dark:text-emerald-300/70 dark:hover:text-emerald-300"
                >
                    <X aria-hidden="true" className="size-4" />
                </button>
            </div>
        </div>
    )
}
