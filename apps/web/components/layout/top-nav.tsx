'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronLeft, FolderGit2, LayoutDashboard, Library, Menu, Settings, X, type LucideIcon } from 'lucide-react'
import { SettingsTabs } from '@/components/settings/settings-tabs'
import { useScrollSpy, type ScrollSpySection } from './scroll-spy-context'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { recallHomeUrl } from '@/lib/home-url-memory'
import { NavMenu } from './nav-menu'

// label comes from the 'Nav' namespace keyed by id (Nav.overview, Nav.projects, Nav.libraries).
type NavItem = {
    id: ScrollSpySection
    Icon: LucideIcon
}

const NAV_ITEMS: NavItem[] = [
    { id: 'overview', Icon: LayoutDashboard },
    { id: 'projects', Icon: FolderGit2 },
    { id: 'libraries', Icon: Library }
]

// labelKey resolves against the 'Nav' namespace (Nav.overview / Nav.projects / Nav.libraries) and
// names the section the back link returns to. Pages with a back context drop the logo + nav and
// show only this link, mirroring how project/library details already behaved.
type BackContext = {
    labelKey: 'overview' | 'projects' | 'libraries'
    href: string
}

function backContext(pathname: string): BackContext | null {
    const projectMatch = pathname.match(/^\/projects\/[^/]+/)
    if (projectMatch) return { labelKey: 'projects', href: '/#projects' }
    const libraryMatch = pathname.match(/^\/libraries\/[^/]+/)
    if (libraryMatch) return { labelKey: 'libraries', href: '/#libraries' }
    if (pathname.startsWith('/settings')) return { labelKey: 'overview', href: '/#overview' }
    return null
}

export function TopNav() {
    const pathname = usePathname()
    const t = useTranslations('Nav')
    const { activeSection } = useScrollSpy()
    const onHome = pathname === '/'
    const onSettings = pathname.startsWith('/settings')
    const back = backContext(pathname)
    const currentSection: ScrollSpySection | null = (onHome && (activeSection || 'overview')) || null
    const [rememberedHomeUrl, setRememberedHomeUrl] = useState<string | null>(null)
    const [menuOpen, setMenuOpen] = useState<boolean>(false)
    const headerRef = useRef<HTMLElement>(null)
    // Re-read on pathname change so the back link reflects the most recent
    // homepage filter URL the user produced before navigating in.
    useEffect(function readRemembered() {
        setRememberedHomeUrl(recallHomeUrl())
    }, [pathname])
    // Close the mobile menu whenever the route changes — pathname-only since hash
    // links don't trigger this; the link handlers below also call closeMenu().
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
    const backHref = (back && composeBackHref(rememberedHomeUrl, back.href)) || ''
    const mobileLabel = computeMobileLabel({ onHome, currentSection, t })
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
                                const href = (onHome && '#' + item.id) || '/#' + item.id
                                const className = cn(
                                    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-semibold uppercase tracking-wider transition-colors',
                                    isActive
                                        ? 'bg-accent text-accent-foreground'
                                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                                )
                                return (
                                    <Link key={item.id} href={href} className={className}>
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
                            onHome={onHome}
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

// Picks the short "you are here" label shown in the mobile bar next to the hamburger. Only on home,
// where it follows scroll-spy so the label changes as the user scrolls between sections. Back-context
// pages (project/library details, settings) show the back link in the bar instead, so no chip.
function computeMobileLabel(args: {
    onHome: boolean
    currentSection: ScrollSpySection | null
    t: (key: string) => string
}): string {
    if (!args.onHome) return ''
    const match = NAV_ITEMS.find(function find(i) { return i.id === args.currentSection })
    return (match && args.t(match.id)) || args.t('overview')
}

// Glue the remembered homepage URL's pathname + search to the section hash this
// back button represents. The remembered hash may point at a different section
// (e.g. user scrolled across sections before clicking in), so we always force
// the section we know is correct from the current pathname.
function composeBackHref(rememberedHomeUrl: string | null, fallback: string): string {
    if (!rememberedHomeUrl) return fallback
    const fallbackHashIdx = fallback.indexOf('#')
    const targetHash = (fallbackHashIdx >= 0 && fallback.slice(fallbackHashIdx)) || ''
    const hashIdx = rememberedHomeUrl.indexOf('#')
    const base = (hashIdx >= 0 && rememberedHomeUrl.slice(0, hashIdx)) || rememberedHomeUrl
    return base + targetHash
}
