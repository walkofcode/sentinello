import type { Metadata } from 'next'
import { type ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { routing } from '@/i18n/routing'
import { GITHUB_URL, WALKOFCODE_URL, WEBSITE_URL } from '@/lib/links'
import { ThemeProvider } from '@/components/layout/theme-provider'
import { TopNav } from '@/components/layout/top-nav'
import { SiteFooter } from '@/components/layout/site-footer'
import { Analytics } from '@/components/layout/analytics'
import '../globals.css'

type LayoutProps = {
    children: ReactNode
    params: Promise<{ locale: string }>
}

export function generateStaticParams() {
    return routing.locales.map(function toParam(locale) { return { locale } })
}

// hreflang map — every locale lives under its own /<locale> prefix (localePrefix: 'always').
function localeAlternates(): Record<string, string> {
    const languages: Record<string, string> = {}
    for (const loc of routing.locales) languages[loc] = WEBSITE_URL + '/' + loc
    return languages
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
    const { locale } = await params
    const t = await getTranslations({ locale, namespace: 'Meta' })
    const url = WEBSITE_URL + '/' + locale
    return {
        metadataBase: new URL(WEBSITE_URL),
        title: { default: t('tabTitle'), template: 'Sentinello · %s' },
        description: t('description'),
        applicationName: 'Sentinello',
        keywords: [
            'Node.js dependency scanner',
            'CVE monitoring',
            'self-hosted security',
            'npm audit alternative',
            'vulnerability monitoring',
            'open source SCA',
            'dependency vulnerabilities',
            'Docker'
        ],
        authors: [{ name: 'Walk of Code LLC', url: WALKOFCODE_URL }],
        creator: 'Walk of Code LLC',
        publisher: 'Walk of Code LLC',
        alternates: {
            canonical: url,
            languages: localeAlternates()
        },
        robots: {
            index: true,
            follow: true,
            googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 }
        },
        openGraph: {
            title: t('title'),
            description: t('description'),
            url,
            siteName: 'Sentinello',
            locale,
            type: 'website'
        },
        twitter: {
            card: 'summary_large_image',
            title: t('title'),
            description: t('description')
        }
    }
}

export default async function LocaleLayout({ children, params }: LayoutProps) {
    const { locale } = await params
    if (!hasLocale(routing.locales, locale)) notFound()
    setRequestLocale(locale)
    const t = await getTranslations({ locale, namespace: 'Meta' })
    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Sentinello',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Docker, Linux, macOS, Windows',
        description: t('description'),
        url: WEBSITE_URL,
        downloadUrl: GITHUB_URL,
        license: 'https://opensource.org/licenses/MIT',
        softwareHelp: GITHUB_URL,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        author: { '@type': 'Organization', name: 'Walk of Code LLC', url: WALKOFCODE_URL }
    }
    return (
        <html lang={locale} suppressHydrationWarning>
            <body className="min-h-screen bg-background text-foreground antialiased">
                <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
                <NextIntlClientProvider>
                    <ThemeProvider>
                        <div className="flex min-h-screen flex-col">
                            <TopNav />
                            <main className="flex-1">{children}</main>
                            <SiteFooter />
                        </div>
                    </ThemeProvider>
                </NextIntlClientProvider>
                <Analytics />
            </body>
        </html>
    )
}
