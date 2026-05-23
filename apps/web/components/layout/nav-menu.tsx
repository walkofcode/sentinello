'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { useTheme } from 'next-themes'
import { useLocale, useTranslations } from 'next-intl'
import {
    ALargeSmall,
    Check,
    ChevronDown,
    Languages,
    Moon,
    Settings,
    Sun,
    type LucideIcon
} from 'lucide-react'
import { useFontSize, type FontSize } from './font-size-provider'
import { cn } from '@/lib/cn'
import { locales, LOCALE_LABELS, type Locale } from '@/i18n/config'
import { setLocale } from '@/i18n/set-locale'
import type { ScrollSpySection } from './scroll-spy-context'

type NavItem = {
    id: ScrollSpySection
    Icon: LucideIcon
}

type Props = {
    navItems: NavItem[]
    onHome: boolean
    onSettings: boolean
    currentSection: ScrollSpySection | null
    onNavigate: () => void
}

type Submenu = 'language' | 'fontSize' | null

const FONT_SIZE_OPTIONS: { value: FontSize; labelKey: string }[] = [
    { value: 'small', labelKey: 'fontSmall' },
    { value: 'normal', labelKey: 'fontNormal' },
    { value: 'large', labelKey: 'fontLarge' },
    { value: 'extra-large', labelKey: 'fontExtraLarge' }
]

const ROW_BASE = 'flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm transition-colors'

export function NavMenu({ navItems, onHome, onSettings, currentSection, onNavigate }: Props) {
    const t = useTranslations('Nav')
    const [submenu, setSubmenu] = useState<Submenu>(null)
    function toggleSubmenu(next: Exclude<Submenu, null>) {
        setSubmenu(function flip(prev) { return prev === next ? null : next })
    }
    return (
        <div
            role="menu"
            className="absolute right-0 top-full z-40 mt-2 max-h-[80vh] w-64 overflow-y-auto rounded-md border bg-card p-1 shadow-md"
        >
            <div className="space-y-0.5 md:hidden">
                {navItems.map(function navItem(item) {
                    const isActive = item.id === currentSection
                    const href = (onHome && '#' + item.id) || '/#' + item.id
                    return (
                        <Link
                            key={item.id}
                            href={href}
                            onClick={onNavigate}
                            role="menuitem"
                            className={cn(
                                ROW_BASE,
                                'font-semibold uppercase tracking-wider',
                                isActive
                                    ? 'bg-accent text-accent-foreground'
                                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                            )}
                        >
                            <item.Icon className="h-4 w-4" />
                            <span>{t(item.id)}</span>
                        </Link>
                    )
                })}
                <Link
                    href="/settings"
                    onClick={onNavigate}
                    role="menuitem"
                    className={cn(
                        ROW_BASE,
                        'font-medium',
                        onSettings
                            ? 'bg-accent text-accent-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    )}
                >
                    <Settings className="h-4 w-4" />
                    <span>{t('settings')}</span>
                </Link>
                <div className="my-1 border-t" />
            </div>
            <ThemeRow />
            <LanguageRow expanded={submenu === 'language'} onToggle={function open() { toggleSubmenu('language') }} />
            <FontSizeRow expanded={submenu === 'fontSize'} onToggle={function open() { toggleSubmenu('fontSize') }} />
        </div>
    )
}

function ThemeRow() {
    const { theme, setTheme, resolvedTheme } = useTheme()
    const t = useTranslations('Common')
    const current = theme === 'system' ? resolvedTheme : theme
    const isDark = current === 'dark'
    function toggle() {
        setTheme(isDark ? 'light' : 'dark')
    }
    return (
        <button
            type="button"
            role="menuitem"
            onClick={toggle}
            className={cn(ROW_BASE, 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}
        >
            {isDark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            <span>{t('theme')}</span>
            <span className="ml-auto text-xs text-muted-foreground">{isDark ? t('dark') : t('light')}</span>
        </button>
    )
}

function LanguageRow({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
    const t = useTranslations('Nav')
    const active = useLocale()
    const router = useRouter()
    const [pending, startTransition] = useTransition()
    function choose(next: Locale) {
        if (next === active) return
        // Persist the cookie server-side, then refresh so every server component re-renders in the
        // new language. The transition keeps the current UI interactive while the refresh resolves.
        startTransition(async function apply() {
            await setLocale(next)
            router.refresh()
        })
    }
    return (
        <div>
            <button
                type="button"
                role="menuitem"
                onClick={onToggle}
                aria-haspopup="menu"
                aria-expanded={expanded}
                disabled={pending}
                className={cn(ROW_BASE, 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}
            >
                <Languages className="h-4 w-4" />
                <span>{t('language')}</span>
                <span className="ml-auto text-xs text-muted-foreground">{LOCALE_LABELS[active as Locale]}</span>
                <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
            </button>
            {expanded && (
                <div role="menu" className="mx-1 mb-1 space-y-0.5 rounded-md bg-accent/40 p-1">
                    {locales.map(function opt(code) {
                        const isActive = code === active
                        return (
                            <button
                                key={code}
                                type="button"
                                role="menuitemradio"
                                aria-checked={isActive}
                                disabled={pending}
                                onClick={function onClick() { choose(code) }}
                                className={cn(
                                    ROW_BASE,
                                    isActive
                                        ? 'bg-accent text-accent-foreground'
                                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                                )}
                            >
                                <Check className={cn('h-4 w-4', !isActive && 'opacity-0')} />
                                <span>{LOCALE_LABELS[code]}</span>
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

function FontSizeRow({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
    const { size, setSize } = useFontSize()
    const t = useTranslations('Common')
    return (
        <div>
            <button
                type="button"
                role="menuitem"
                onClick={onToggle}
                aria-haspopup="menu"
                aria-expanded={expanded}
                className={cn(ROW_BASE, 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')}
            >
                <ALargeSmall className="h-4 w-4" />
                <span>{t('fontSize')}</span>
                <ChevronDown className={cn('ml-auto h-4 w-4 transition-transform', expanded && 'rotate-180')} />
            </button>
            {expanded && (
                <div role="menu" className="mx-1 mb-1 space-y-0.5 rounded-md bg-accent/40 p-1">
                    {FONT_SIZE_OPTIONS.map(function opt(o) {
                        const isActive = o.value === size
                        return (
                            <button
                                key={o.value}
                                type="button"
                                role="menuitemradio"
                                aria-checked={isActive}
                                onClick={function onClick() { setSize(o.value) }}
                                className={cn(
                                    ROW_BASE,
                                    isActive
                                        ? 'bg-accent text-accent-foreground'
                                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                                )}
                            >
                                <Check className={cn('h-4 w-4', !isActive && 'opacity-0')} />
                                <span>{t(o.labelKey)}</span>
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
