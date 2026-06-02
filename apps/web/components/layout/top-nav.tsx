'use client'

import Image from 'next/image'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronLeft, FolderGit2, Library, Settings, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { recallLibrariesUrl, recallProjectsUrl } from '@/lib/home-url-memory'

export type NavSection = 'projects' | 'libraries' | 'settings'

// label comes from the 'Nav' namespace keyed by id (Nav.projects, Nav.libraries, Nav.settings).
export type NavItem = {
    id: NavSection
    Icon: LucideIcon
    href: string
}

const NAV_ITEMS: NavItem[] = [
    { id: 'projects', Icon: FolderGit2, href: '/' },
    { id: 'libraries', Icon: Library, href: '/libraries' },
    { id: 'settings', Icon: Settings, href: '/settings' }
]

type BackContext = {
    labelKey: NavSection
    href: string
}

function backContext(pathname: string): BackContext | null {
    if (pathname.match(/^\/projects\/[^/]+/)) return { labelKey: 'projects', href: '/' }
    if (pathname.match(/^\/libraries\/[^/]+/)) return { labelKey: 'libraries', href: '/libraries' }
    return null
}

function currentSectionFor(pathname: string): NavSection | null {
    if (pathname === '/') return 'projects'
    if (pathname === '/libraries' || pathname.startsWith('/libraries/')) return 'libraries'
    if (pathname.startsWith('/settings')) return 'settings'
    return null
}

export function TopNav({ whatsNew }: { whatsNew?: ReactNode }) {
    const pathname = usePathname()
    const t = useTranslations('Nav')
    const back = backContext(pathname)
    const currentSection = currentSectionFor(pathname)
    const [rememberedUrl, setRememberedUrl] = useState<string | null>(null)
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
    const backHref = (back && (rememberedUrl || back.href)) || ''
    return (
        <header className="sticky top-0 z-30 border-b bg-card/80 backdrop-blur">
            <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 md:gap-6">
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
                            <span className="hidden sm:inline">Sentinello</span>
                        </Link>
                        <nav className="flex items-center gap-1 text-xs">
                            {NAV_ITEMS.map(function navItem(item) {
                                const isActive = item.id === currentSection
                                const className = cn(
                                    'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-semibold uppercase tracking-wider transition-colors md:px-3',
                                    isActive
                                        ? 'bg-accent text-accent-foreground'
                                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                                )
                                return (
                                    <Link key={item.id} href={item.href} className={className}>
                                        <item.Icon className="h-4 w-4" />
                                        <span className="hidden sm:inline">{t(item.id)}</span>
                                    </Link>
                                )
                            })}
                        </nav>
                        {whatsNew ? <div className="hidden md:flex">{whatsNew}</div> : null}
                    </>
                )}
            </div>
        </header>
    )
}
