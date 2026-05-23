'use client'

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { useTranslations } from 'next-intl'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

// Plain light/dark switch. Reads the resolved appearance and flips to the opposite, so the button
// always shows a sun or moon — no ambiguous "system" monitor icon that leaves visitors guessing.
// Mounted guard avoids a hydration mismatch since the resolved theme is only known on the client.
export function ThemeToggle() {
    const { resolvedTheme, setTheme } = useTheme()
    const t = useTranslations('Theme')
    const [mounted, setMounted] = useState<boolean>(false)
    useEffect(function markMounted() {
        setMounted(true)
    }, [])
    const isDark = mounted && resolvedTheme === 'dark'
    function toggle() {
        setTheme(isDark ? 'light' : 'dark')
    }
    return (
        <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            aria-label={t('toggle')}
            title={isDark ? t('light') : t('dark')}
        >
            {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </Button>
    )
}
