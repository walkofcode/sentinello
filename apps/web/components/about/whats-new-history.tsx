import { getLocale, getTranslations } from 'next-intl/server'
import { getAllHighlights } from '@/lib/release-highlights'

type ReleaseCopy = {
    version: string
    title: string
    items: string[]
}

export async function WhatsNewHistory() {
    const t = await getTranslations('WhatsNew')
    const locale = await getLocale()
    // releases is an array keyed by a `version` field — next-intl forbids '.' in message
    // keys, so the version can't be an object key. Match each highlight by value below.
    const releases = t.raw('releases') as ReleaseCopy[]
    const highlights = getAllHighlights()
    return (
        <section id="whats-new" className="scroll-mt-20 space-y-4">
            <div className="space-y-2">
                <h2 className="text-xl font-semibold">{t('historyTitle')}</h2>
                <p className="text-muted-foreground">{t('historyIntro')}</p>
            </div>
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
                    <div key={meta.version} className="space-y-3 rounded-(--radius-card) border bg-card p-6">
                        <div className="flex items-baseline justify-between gap-3">
                            <h3 className="text-base font-semibold">{copy.title}</h3>
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
                    </div>
                )
            })}
        </section>
    )
}
