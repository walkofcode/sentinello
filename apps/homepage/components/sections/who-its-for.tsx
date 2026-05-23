import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { Section } from './section'

const POINTS = ['point1', 'point2', 'point3']

export function WhoItsFor() {
    const t = useTranslations('WhoFor')
    return (
        <Section id="whoFor" muted className="!border-b-0">
            <div className="max-w-3xl">
                <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
                <p className="mt-5 text-lg leading-relaxed text-muted-foreground">{t('lead')}</p>
                <ul className="mt-6 space-y-3">
                    {POINTS.map(function point(key) {
                        return (
                            <li key={key} className="flex gap-3">
                                <Check className="mt-1 h-4 w-4 shrink-0 text-success" />
                                <span className="leading-relaxed text-foreground/90">{t(key)}</span>
                            </li>
                        )
                    })}
                </ul>
                <p className="mt-6 leading-relaxed text-muted-foreground">{t('honest')}</p>
            </div>
        </Section>
    )
}
