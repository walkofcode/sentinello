'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
    Bell,
    CalendarClock,
    ChevronDown,
    CircleUser,
    Database,
    FileText,
    Filter,
    FolderTree,
    Info,
    Plug,
    Settings2,
    type LucideIcon
} from 'lucide-react'
import { cn } from '@/lib/cn'

type SettingsSection = {
    href: string
    key: string
    Icon: LucideIcon
}

const SETTINGS_SECTIONS: SettingsSection[] = [
    { href: '/settings/roots', key: 'roots', Icon: FolderTree },
    { href: '/settings/profile', key: 'profile', Icon: CircleUser },
    { href: '/settings/schedule', key: 'schedule', Icon: CalendarClock },
    { href: '/settings/notifications', key: 'notifications', Icon: Bell },
    { href: '/settings/sources', key: 'sources', Icon: Database },
    { href: '/settings/defaults', key: 'defaults', Icon: Filter },
    { href: '/settings/export', key: 'export', Icon: FileText },
    { href: '/settings/advanced', key: 'advanced', Icon: Settings2 },
    { href: '/settings/mcp', key: 'mcp', Icon: Plug },
    { href: '/settings/about', key: 'about', Icon: Info }
]

function isActiveSection(pathname: string, href: string): boolean {
    return pathname === href || pathname.startsWith(href + '/')
}

const ROW_BASE = 'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors'

export function SettingsNav() {
    const pathname = usePathname()
    const t = useTranslations('Nav.tabs')
    const [open, setOpen] = useState<boolean>(false)
    const active = SETTINGS_SECTIONS.find(function matches(s) { return isActiveSection(pathname, s.href) })
    function close() {
        setOpen(false)
    }
    function toggle() {
        setOpen(function flip(prev) { return !prev })
    }
    return (
        <>
            <nav className="hidden flex-col gap-0.5 rounded-(--radius-card) border bg-card p-2 md:flex">
                {SETTINGS_SECTIONS.map(function renderItem(section) {
                    const activeItem = isActiveSection(pathname, section.href)
                    return (
                        <Link
                            key={section.href}
                            href={section.href}
                            className={cn(
                                ROW_BASE,
                                activeItem
                                    ? 'bg-accent font-medium text-accent-foreground'
                                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                            )}
                        >
                            <section.Icon className="h-4 w-4 shrink-0" />
                            <span>{t(section.key)}</span>
                        </Link>
                    )
                })}
            </nav>
            <div className="relative md:hidden">
                <button
                    type="button"
                    onClick={toggle}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    className={cn(
                        ROW_BASE,
                        'border bg-card font-medium text-foreground hover:bg-accent hover:text-accent-foreground'
                    )}
                >
                    {active ? <active.Icon className="h-4 w-4 shrink-0" /> : null}
                    <span>{active ? t(active.key) : t('roots')}</span>
                    <ChevronDown className={cn('ml-auto h-4 w-4 transition-transform', open && 'rotate-180')} />
                </button>
                {open ? (
                    <nav
                        role="menu"
                        className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[70vh] space-y-0.5 overflow-y-auto rounded-md border bg-card p-1 shadow-md"
                    >
                        {SETTINGS_SECTIONS.map(function renderItem(section) {
                            const activeItem = isActiveSection(pathname, section.href)
                            return (
                                <Link
                                    key={section.href}
                                    href={section.href}
                                    role="menuitem"
                                    onClick={close}
                                    className={cn(
                                        ROW_BASE,
                                        activeItem
                                            ? 'bg-accent font-medium text-accent-foreground'
                                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                                    )}
                                >
                                    <section.Icon className="h-4 w-4 shrink-0" />
                                    <span>{t(section.key)}</span>
                                </Link>
                            )
                        })}
                    </nav>
                ) : null}
            </div>
        </>
    )
}
