import { useTranslations } from 'next-intl'
import { Database, FileSearch, KeyRound, Plug, ArrowRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { GITHUB_ISSUES_URL } from '@/lib/links'
import { Section } from './section'

const ITEMS: { key: string; Icon: LucideIcon }[] = [
    { key: 'sources', Icon: Database },
    { key: 'integrations', Icon: Plug },
    { key: 'sast', Icon: FileSearch },
    { key: 'secrets', Icon: KeyRound }
]

export function Roadmap() {
    const t = useTranslations('Roadmap')
    return (
        <Section id="roadmap">
            <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
            <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{t('subtitle')}</p>
            <div className="mt-10 grid gap-4 sm:grid-cols-2">
                {ITEMS.map(function item({ key, Icon }) {
                    return (
                        <div key={key} className="rounded-card border bg-card p-5">
                            <div className="flex items-center gap-2.5">
                                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                                    <Icon className="h-4 w-4" />
                                </span>
                                <h3 className="text-sm font-semibold">{t(key + 'Title')}</h3>
                                <span className="ml-auto rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                                    {t('planned')}
                                </span>
                            </div>
                            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(key + 'Body')}</p>
                        </div>
                    )
                })}
            </div>
            <div className="mt-8">
                <a
                    href={GITHUB_ISSUES_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-7 text-base font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                    {t('cta')}
                    <ArrowRight className="h-4 w-4" />
                </a>
                <p className="mt-3 text-sm text-muted-foreground">{t('ctaNote')}</p>
            </div>
        </Section>
    )
}
