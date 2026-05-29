import { useLocale, useTranslations } from 'next-intl'
import { getReleaseCopy, getReleases, type Locale } from '@sentinello/core'
import { Section } from './section'

// Release history pulled from the shared @sentinello/core data — the same source the portal's
// "What's new" pill and About → Release notes read from. Signals an actively maintained project.
export function ReleaseNotes() {
    const t = useTranslations('ReleaseNotes')
    const locale = useLocale() as Locale
    const releases = getReleases()
    return (
        <Section id="releaseNotes">
            <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
            <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{t('subtitle')}</p>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
                {releases.map(function entry(meta) {
                    const copy = getReleaseCopy(locale, meta.version)
                    if (!copy) return null
                    const date = new Date(meta.date + 'T00:00:00Z').toLocaleDateString(locale, {
                        dateStyle: 'medium',
                        timeZone: 'UTC'
                    })
                    return (
                        <div key={meta.version} className="rounded-card border bg-card p-5">
                            <div className="flex items-baseline gap-2.5">
                                <h3 className="text-sm font-semibold">{copy.title}</h3>
                                <span className="ml-auto shrink-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                    v{meta.version} · {date}
                                </span>
                            </div>
                            <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-muted-foreground">
                                {copy.items.map(function li(item, index) {
                                    return (
                                        <li key={index} className="flex gap-2">
                                            <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                                            <span>{item}</span>
                                        </li>
                                    )
                                })}
                            </ul>
                        </div>
                    )
                })}
            </div>
        </Section>
    )
}
