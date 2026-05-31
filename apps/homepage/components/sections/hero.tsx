import { useTranslations } from 'next-intl'
import { ArrowRight, BookOpen, Cpu } from 'lucide-react'
import { DOCKER_RUN_COMMAND, GITHUB_URL } from '@/lib/links'
import { CopyBlock } from '@/components/ui/copy-block'
import { GitHubStars } from '@/components/ui/github-stars'

export function Hero() {
    const t = useTranslations('Hero')
    return (
        <section>
            <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:py-28">
                <h1 className="max-w-3xl text-4xl font-bold tracking-tight text-balance sm:text-5xl">
                    {t('title')}
                </h1>
                <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground">{t('subtitle')}</p>
                <div className="mt-8 max-w-2xl">
                    <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                        <ArrowRight className="h-4 w-4 text-primary" />
                        {t('commandCaption')}
                    </p>
                    <CopyBlock code={DOCKER_RUN_COMMAND} />
                    <p className="mt-3 inline-flex items-center gap-2 text-sm text-muted-foreground">
                        <Cpu className="h-4 w-4" />
                        {t('multiArch')}
                    </p>
                </div>
                <div className="mt-6 flex flex-wrap items-center gap-3">
                    <a
                        href={GITHUB_URL + '#quick-start'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-7 text-base font-medium text-primary-foreground transition-opacity hover:opacity-90"
                    >
                        <BookOpen className="h-4 w-4" />
                        {t('ctaPrimary')}
                    </a>
                    <GitHubStars label={t('ctaSecondary')} />
                </div>
                <p className="mt-6 text-sm text-muted-foreground">{t('trust')}</p>
            </div>
        </section>
    )
}
