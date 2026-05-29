import { getLocale, getTranslations } from 'next-intl/server'
import { getReleaseCopy, getReleases, type Locale } from '@sentinello/core'

export async function WhatsNewHistory() {
    const t = await getTranslations('WhatsNew')
    const locale = (await getLocale()) as Locale
    // Highlights come from the shared @sentinello/core data (single source of truth across the
    // portal and the homepage); only the section chrome below is localized via next-intl.
    const highlights = getReleases()
    return (
        <section id="whats-new" className="scroll-mt-20 space-y-4">
            <div className="space-y-2">
                <h2 className="text-xl font-semibold">{t('historyTitle')}</h2>
                <p className="text-muted-foreground">{t('historyIntro')}</p>
            </div>
            {highlights.map(function renderRelease(meta) {
                const copy = getReleaseCopy(locale, meta.version)
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
