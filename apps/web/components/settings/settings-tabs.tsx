'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'

const TABS = [
    { href: '/settings/roots', key: 'roots' },
    { href: '/settings/schedule', key: 'schedule' },
    { href: '/settings/notifications', key: 'notifications' },
    { href: '/settings/defaults', key: 'defaults' },
    { href: '/settings/export', key: 'export' },
    { href: '/settings/advanced', key: 'advanced' },
    { href: '/settings/about', key: 'about' }
]

export function SettingsTabs() {
    const pathname = usePathname()
    const t = useTranslations('Nav.tabs')
    return (
        <nav className="flex flex-wrap items-center gap-1 text-sm">
            {TABS.map(function renderTab(tab) {
                const isActive = pathname === tab.href || pathname.startsWith(tab.href + '/')
                const className = isActive
                    ? 'rounded-md bg-accent px-3 py-1.5 font-medium text-accent-foreground'
                    : 'rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
                return (
                    <Link key={tab.href} href={tab.href} className={className}>
                        {t(tab.key)}
                    </Link>
                )
            })}
        </nav>
    )
}
