import { useTranslations } from 'next-intl'
import { BookOpen, Cpu } from 'lucide-react'
import { DOCKER_COMPOSE_SNIPPET, DOCKER_RUN_COMMAND, GITHUB_URL, PM2_SNIPPET } from '@/lib/links'
import { Section } from './section'
import { CommandTabs } from '@/components/ui/command-tabs'
import { GithubIcon } from '@/components/ui/github-icon'

export function SelfHost() {
    const t = useTranslations('SelfHost')
    const tabs = [
        { id: 'run', label: t('runTab'), code: DOCKER_RUN_COMMAND },
        { id: 'compose', label: t('composeTab'), code: DOCKER_COMPOSE_SNIPPET },
        { id: 'pm2', label: t('pm2Tab'), code: PM2_SNIPPET }
    ]
    return (
        <Section id="selfHost">
            <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
            <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{t('subtitle')}</p>
            <div className="mt-8 max-w-3xl">
                <CommandTabs tabs={tabs} />
            </div>
            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">{t('rootsNote')}</p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                    <Cpu className="h-4 w-4" />
                    {t('multiArch')}
                </span>
                <a
                    href={GITHUB_URL + '#quick-start'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 font-medium text-foreground/80 transition-colors hover:text-foreground"
                >
                    <BookOpen className="h-4 w-4" />
                    {t('docsLink')}
                </a>
                <a
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 font-medium text-foreground/80 transition-colors hover:text-foreground"
                >
                    <GithubIcon className="h-4 w-4" />
                    {t('githubLink')}
                </a>
            </div>
        </Section>
    )
}
