import { getLocale, getTranslations } from 'next-intl/server'
import { getAllHighlights } from '@/lib/release-highlights'

type ReleaseCopy = {
    version: string
    title: string
    items: string[]
}

export async function WhatsNewContent() {
    const t = await getTranslations('WhatsNew')
    const locale = await getLocale()
    // releases is an array keyed by a `version` field — next-intl forbids '.' in message
    // keys, so the version can't be an object key. Match each highlight by value below.
    const releases = t.raw('releases') as ReleaseCopy[]
    const highlights = getAllHighlights()
    return (
        <div className="content mx-auto max-w-3xl space-y-8">
            <header className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight">{t('pageTitle')}</h1>
                <p className="text-muted-foreground">{t('pageIntro')}</p>
            </header>
            {highlights.map(function renderRelease(meta) {
                const copy = releases.find(function byVersion(entry) {
                    return entry.version === meta.version
                })
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
