'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Check, Globe } from 'lucide-react'
import { usePathname, useRouter } from '@/i18n/navigation'
import { locales, LOCALE_LABELS, type Locale } from '@/i18n/config'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

export function LanguageSwitcher() {
    const router = useRouter()
    const pathname = usePathname()
    const active = useLocale() as Locale
    const t = useTranslations('Language')
    const [open, setOpen] = useState<boolean>(false)
    const wrapRef = useRef<HTMLDivElement>(null)
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
    function pick(next: Locale) {
        setOpen(false)
        // Replace only the locale prefix; usePathname here is already prefix-stripped.
        router.replace(pathname, { locale: next })
    }
    return (
        <div ref={wrapRef} className="relative">
            <Button
                variant="ghost"
                size="sm"
                onClick={function toggle() { setOpen(function flip(p) { return !p }) }}
                aria-label={t('label')}
                aria-haspopup="menu"
                aria-expanded={open}
                className="gap-1.5"
            >
                <Globe className="h-5 w-5" />
                <span className="hidden text-sm font-medium sm:inline">{LOCALE_LABELS[active]}</span>
                <span className="text-sm font-medium sm:hidden">{active.split('-')[0].toUpperCase()}</span>
            </Button>
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 z-40 mt-1 max-h-80 w-44 overflow-auto rounded-md border bg-card p-1 shadow-lg"
                >
                    {locales.map(function item(loc) {
                        const isActive = loc === active
                        return (
                            <button
                                key={loc}
                                role="menuitemradio"
                                aria-checked={isActive}
                                onClick={function choose() { pick(loc) }}
                                className={cn(
                                    'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                                    isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                                )}
                            >
                                <span>{LOCALE_LABELS[loc]}</span>
                                {isActive && <Check className="h-4 w-4" />}
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
