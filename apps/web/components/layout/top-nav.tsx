'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronLeft, FolderGit2, Library, Menu, Settings, X, type LucideIcon } from 'lucide-react'
import { SettingsTabs } from '@/components/settings/settings-tabs'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { recallLibrariesUrl, recallProjectsUrl } from '@/lib/home-url-memory'
import { NavMenu } from './nav-menu'

export type NavSection = 'projects' | 'libraries'

// label comes from the 'Nav' namespace keyed by id (Nav.projects, Nav.libraries).
export type NavItem = {
    id: NavSection
    Icon: LucideIcon
    href: string
}

const NAV_ITEMS: NavItem[] = [
    { id: 'projects', Icon: FolderGit2, href: '/' },
    { id: 'libraries', Icon: Library, href: '/libraries' }
]

type BackContext = {
    labelKey: NavSection
    href: string
}

function backContext(pathname: string): BackContext | null {
    if (pathname.match(/^\/projects\/[^/]+/)) return { labelKey: 'projects', href: '/' }
    if (pathname.match(/^\/libraries\/[^/]+/)) return { labelKey: 'libraries', href: '/libraries' }
    if (pathname.startsWith('/settings')) return { labelKey: 'projects', href: '/' }
    return null
}

function currentSectionFor(pathname: string): NavSection | null {
    if (pathname === '/') return 'projects'
    if (pathname === '/libraries' || pathname.startsWith('/libraries/')) return 'libraries'
    return null
}

export function TopNav({ whatsNew }: { whatsNew?: ReactNode }) {
    const pathname = usePathname()
    const t = useTranslations('Nav')
    const onSettings = pathname.startsWith('/settings')
    const back = backContext(pathname)
    const currentSection = currentSectionFor(pathname)
    const [rememberedUrl, setRememberedUrl] = useState<string | null>(null)
    const [menuOpen, setMenuOpen] = useState<boolean>(false)
    const headerRef = useRef<HTMLElement>(null)
    // Re-read on pathname change so the back link reflects the most recent filter URL the user
    // produced for the page they're returning to.
    useEffect(function readRemembered() {
        if (!back) {
            setRememberedUrl(null)
            return
        }
        const remembered = back.labelKey === 'libraries' ? recallLibrariesUrl() : recallProjectsUrl()
        setRememberedUrl(remembered)
    }, [pathname, back])
    // Close the mobile menu whenever the route changes.
    useEffect(function closeOnNav() {
        setMenuOpen(false)
    }, [pathname])
    // Close on Esc and on outside click while the menu is open.
    useEffect(function bindMenuKeys() {
        if (!menuOpen) return
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') setMenuOpen(false)
        }
        function onClick(e: MouseEvent) {
            const target = e.target as Node | null
            if (headerRef.current && target && !headerRef.current.contains(target)) {
                setMenuOpen(false)
            }
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onClick)
        return function cleanup() {
            document.removeEventListener('keydown', onKey)
            document.removeEventListener('mousedown', onClick)
        }
    }, [menuOpen])
    const backHref = (back && (rememberedUrl || back.href)) || ''
    const mobileLabel = (currentSection && t(currentSection)) || ''
    function closeMenu() {
        setMenuOpen(false)
    }
    function toggleMenu() {
        setMenuOpen(function flip(prev) { return !prev })
    }
    return (
        <header ref={headerRef} className="sticky top-0 z-30 border-b bg-card/80 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
                {back ? (
                    <Link
                        href={backHref}
                        className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                        <ChevronLeft className="h-4 w-4" />
                        {t(back.labelKey)}
                    </Link>
                ) : (
                    <>
                        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
                            <Image
                                src="/sentinello-logo.png"
                                alt="Sentinello"
                                width={40}
                                height={40}
                                priority
                                className="h-10 w-10"
                            />
                            <span>Sentinello</span>
                        </Link>
                        <nav className="hidden items-center gap-1 text-xs md:flex">
                            {NAV_ITEMS.map(function navItem(item) {
                                const isActive = item.id === currentSection
                                const className = cn(
                                    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-semibold uppercase tracking-wider transition-colors',
                                    isActive
                                        ? 'bg-accent text-accent-foreground'
                                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                                )
                                return (
                                    <Link key={item.id} href={item.href} className={className}>
                                        <item.Icon className="h-4 w-4" />
                                        {t(item.id)}
                                    </Link>
                                )
                            })}
                            <Link
                                href="/settings"
                                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                            >
                                <Settings className="h-4 w-4" />
                                {t('settings')}
                            </Link>
                        </nav>
                    </>
                )}
                {onSettings ? (
                    <div className="hidden md:block">
                        <SettingsTabs />
                    </div>
                ) : null}
                <div className="relative ml-auto flex items-center gap-2">
                    {mobileLabel ? (
                        <span className="max-w-[40vw] truncate rounded-md bg-accent/50 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-accent-foreground md:hidden">
                            {mobileLabel}
                        </span>
                    ) : null}
                    {whatsNew}
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleMenu}
                        aria-label={menuOpen ? t('closeMenu') : t('openMenu')}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                    >
                        {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                    </Button>
                    {menuOpen ? (
                        <NavMenu
                            navItems={NAV_ITEMS}
                            onSettings={onSettings}
                            currentSection={currentSection}
                            onNavigate={closeMenu}
                        />
                    ) : null}
                </div>
            </div>
        </header>
    )
}
