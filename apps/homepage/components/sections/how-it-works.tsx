import { useTranslations } from 'next-intl'
import { Section } from './section'

const STEPS = ['step1', 'step2', 'step3']

export function HowItWorks() {
    const t = useTranslations('How')
    return (
        <Section id="how">
            <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
            <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{t('subtitle')}</p>
            <div className="mt-10 grid gap-6 sm:grid-cols-3">
                {STEPS.map(function step(key) {
                    return (
                        <div key={key} className="rounded-card border bg-card p-6">
                            <h3 className="font-semibold">{t(key + 'Title')}</h3>
                            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t(key + 'Body')}</p>
                        </div>
                    )
                })}
            </div>
        </Section>
    )
}
