'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { useTheme } from 'next-themes'
import { useLocale, useTranslations } from 'next-intl'
import { Moon, Sun, type LucideIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/cn'
import { locales, LOCALE_LABELS, type Locale } from '@/i18n/config'
import { setLocale } from '@/i18n/set-locale'
import { useFontSize, type FontSize } from '@/components/layout/font-size-provider'

const THEME_OPTIONS: { value: 'light' | 'dark'; labelKey: string; Icon: LucideIcon }[] = [
    { value: 'light', labelKey: 'light', Icon: Sun },
    { value: 'dark', labelKey: 'dark', Icon: Moon }
]

// Each option previews its own scale so the choice reads at the size it applies.
const FONT_SIZE_OPTIONS: { value: FontSize; labelKey: string; preview: string }[] = [
    { value: 'small', labelKey: 'fontSmall', preview: 'text-xs' },
    { value: 'normal', labelKey: 'fontNormal', preview: 'text-sm' },
    { value: 'large', labelKey: 'fontLarge', preview: 'text-base' },
    { value: 'extra-large', labelKey: 'fontExtraLarge', preview: 'text-lg' }
]

const OPTION_BASE = 'flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors'

function optionClass(isActive: boolean): string {
    return cn(
        OPTION_BASE,
        isActive
            ? 'border-primary bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
    )
}

export function ProfileForm() {
    return (
        <div className="space-y-6">
            <ThemeCard />
            <LanguageCard />
            <FontSizeCard />
        </div>
    )
}

function ThemeCard() {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const { theme, setTheme, resolvedTheme } = useTheme()
    const [mounted, setMounted] = useState(false)
    useEffect(function onMount() { setMounted(true) }, [])
    const current = theme === 'system' ? resolvedTheme : theme
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('profile.theme')}</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
                    {THEME_OPTIONS.map(function opt(o) {
                        const isActive = mounted && current === o.value
                        return (
                            <button
                                key={o.value}
                                type="button"
                                role="radio"
                                aria-checked={isActive}
                                onClick={function onClick() { setTheme(o.value) }}
                                className={optionClass(isActive)}
                            >
                                <o.Icon className="h-4 w-4 shrink-0" />
                                <span>{tc(o.labelKey)}</span>
                            </button>
                        )
                    })}
                </div>
            </CardContent>
        </Card>
    )
}

function LanguageCard() {
    const t = useTranslations('Settings')
    const active = useLocale()
    const router = useRouter()
    const [pending, startTransition] = useTransition()
    function choose(next: string) {
        if (next === active) return
        // Persist the cookie server-side, then refresh so every server component re-renders in the
        // new language. The transition keeps the current UI interactive while the refresh resolves.
        startTransition(async function apply() {
            await setLocale(next as Locale)
            router.refresh()
        })
    }
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('profile.language')}</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="sm:max-w-xs">
                    <Select
                        value={active}
                        disabled={pending}
                        onChange={function onChange(e) { choose(e.target.value) }}
                        className="w-full"
                    >
                        {locales.map(function opt(code) {
                            return <option key={code} value={code}>{LOCALE_LABELS[code]}</option>
                        })}
                    </Select>
                </div>
            </CardContent>
        </Card>
    )
}

function FontSizeCard() {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const { size, setSize } = useFontSize()
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('profile.fontSize')}</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {FONT_SIZE_OPTIONS.map(function opt(o) {
                        const isActive = o.value === size
                        return (
                            <button
                                key={o.value}
                                type="button"
                                role="radio"
                                aria-checked={isActive}
                                onClick={function onClick() { setSize(o.value) }}
                                className={optionClass(isActive)}
                            >
                                <span className={o.preview}>{tc(o.labelKey)}</span>
                            </button>
                        )
                    })}
                </div>
            </CardContent>
        </Card>
    )
}
