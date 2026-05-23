'use client'

import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { GitHubStarsLink } from '@/components/ui/github-stars-link'
import { SectionMenu } from './section-menu'
import { ThemeToggle } from './theme-toggle'
import { LanguageSwitcher } from './language-switcher'

export function TopNav() {
    const t = useTranslations('Nav')
    return (
        <header className="sticky top-0 z-30 border-b bg-card/80 backdrop-blur">
            <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-4">
                <Link href="/" className="flex shrink-0 items-center gap-2 text-lg font-semibold tracking-tight">
                    <Image src="/sentinello-logo.png" alt="Sentinello" width={44} height={44} priority className="h-11 w-11" />
                    <span>Sentinello</span>
                </Link>
                <div className="hidden sm:block">
                    <SectionMenu />
                </div>
                <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
                    <GitHubStarsLink label={t('github')} />
                    <LanguageSwitcher />
                    <ThemeToggle />
                </div>
            </div>
        </header>
    )
}
