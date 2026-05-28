import type { Metadata } from 'next'
import { type ReactNode } from 'react'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'
import { ThemeProvider } from '@/components/layout/theme-provider'
import { FontSizeProvider } from '@/components/layout/font-size-provider'
import { TopNav } from '@/components/layout/top-nav'
import { SiteFooter } from '@/components/layout/site-footer'
import { UpdateBanner } from '@/components/layout/update-banner'
import { WhatsNewPill } from '@/components/layout/whats-new-pill'
import './globals.css'

// Pre-hydration script: applies the user's stored font-size choice to <html>
// before React paints so we don't flash the default size, then the wrong one.
// Mirrors how next-themes avoids the same flash for color theme.
const FONT_SIZE_BOOT_SCRIPT = "(function(){try{var s=localStorage.getItem('sentinello-font-size');if(s!=='small'&&s!=='normal'&&s!=='large'&&s!=='extra-large')s='normal';document.documentElement.setAttribute('data-font-size',s)}catch(e){document.documentElement.setAttribute('data-font-size','normal')}})()"

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('Meta')
    return {
        title: { default: 'Sentinello', template: 'Sentinello · %s' },
        description: t('description')
    }
}

// Every portal page reads live DB state and writes via server actions, so static prerendering
// would deliver stale data. Force dynamic rendering site-wide so each request hits the DB.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function RootLayout({ children }: { children: ReactNode }) {
    const locale = await getLocale()
    const messages = await getMessages()
    return (
        <html lang={locale} data-scroll-behavior="smooth" suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: FONT_SIZE_BOOT_SCRIPT }} />
            </head>
            <body className="min-h-screen bg-background text-foreground antialiased">
                <NextIntlClientProvider locale={locale} messages={messages}>
                    <ThemeProvider>
                        <FontSizeProvider>
                            <div className="flex min-h-screen flex-col">
                                <TopNav whatsNew={<WhatsNewPill />} />
                                <UpdateBanner />
                                <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">{children}</main>
                                <SiteFooter />
                            </div>
                        </FontSizeProvider>
                    </ThemeProvider>
                </NextIntlClientProvider>
            </body>
        </html>
    )
}
