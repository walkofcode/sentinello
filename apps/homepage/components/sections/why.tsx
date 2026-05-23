import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Section } from './section'

export function Why() {
    const t = useTranslations('Why')
    return (
        <Section id="why" muted>
            <div className="max-w-3xl content">
                <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
                <p className="mt-5 text-lg leading-relaxed text-muted-foreground">{t('lead')}</p>
                <p className="mt-4 leading-relaxed text-muted-foreground">{t('body1')}</p>
                <div className="mt-6 flex gap-3 rounded-card border border-destructive/30 bg-destructive/5 p-4">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                    <p className="leading-relaxed text-foreground/90">{t('callout')}</p>
                </div>
                <p className="mt-6 leading-relaxed text-muted-foreground">{t('body2')}</p>
            </div>
        </Section>
    )
}
