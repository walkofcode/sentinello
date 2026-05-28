import { getLocale, getTranslations } from 'next-intl/server'
import { getAllHighlights } from '@/lib/release-highlights'

type ReleaseCopy = {
    title: string
    items: string[]
}

export async function WhatsNewContent() {
    const t = await getTranslations('WhatsNew')
    const locale = await getLocale()
    // The version keys contain dots ("1.4.0"), which next-intl would treat as a nested
    // path — so read the whole `releases` object once and index it by version in JS.
    const releases = t.raw('releases') as Record<string, ReleaseCopy>
    const highlights = getAllHighlights()
    return (
        <div className="content mx-auto max-w-3xl space-y-8">
            <header className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight">{t('pageTitle')}</h1>
                <p className="text-muted-foreground">{t('pageIntro')}</p>
            </header>
            {highlights.map(function renderRelease(meta) {
                const copy = releases[meta.version]
                if (!copy) return null
                const date = new Date(meta.date + 'T00:00:00Z').toLocaleDateString(locale, {
                    dateStyle: 'medium',
                    timeZone: 'UTC'
                })
                return (
                    <section key={meta.version} className="space-y-3 rounded-(--radius-card) border bg-card p-6">
                        <div className="flex items-baseline justify-between gap-3">
                            <h2 className="text-xl font-semibold">{copy.title}</h2>
                            <span className="shrink-0 text-sm text-muted-foreground">v{meta.version} · {date}</span>
                        </div>
                        <ul className="space-y-1.5 text-muted-foreground">
                            {copy.items.map(function renderItem(item, index) {
                                return (
                                    <li key={index} className="flex gap-2">
                                        <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-emerald-500" />
                                        <span>{item}</span>
                                    </li>
                                )
                            })}
                        </ul>
                    </section>
                )
            })}
        </div>
    )
}
