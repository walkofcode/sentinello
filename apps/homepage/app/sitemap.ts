import type { MetadataRoute } from 'next'
import { routing } from '@/i18n/routing'
import { WEBSITE_URL } from '@/lib/links'

// One entry per localized home URL (localePrefix is 'always', so every locale lives under /<locale>).
// Each entry advertises the full set of language alternates for correct hreflang indexing.
export default function sitemap(): MetadataRoute.Sitemap {
    const languages: Record<string, string> = {}
    for (const locale of routing.locales) languages[locale] = WEBSITE_URL + '/' + locale
    return routing.locales.map(function entry(locale) {
        return {
            url: WEBSITE_URL + '/' + locale,
            lastModified: new Date(),
            changeFrequency: 'weekly',
            priority: locale === routing.defaultLocale ? 1 : 0.8,
            alternates: { languages }
        }
    })
}
