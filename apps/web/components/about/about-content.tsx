import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { getVersionInfo } from '@/lib/version'
import { NetworkActivityTable } from './network-activity-table'
import { WhatsNewHistory } from './whats-new-history'

const BUILT_WITH = [
    'Next.js',
    'React',
    'Tailwind CSS',
    'Drizzle ORM',
    'better-sqlite3',
    'lucide-react',
    'Zod'
]

export async function AboutContent() {
    const t = await getTranslations('About')
    const info = await getVersionInfo()
    return (
        <div className="content mx-auto max-w-3xl space-y-10">
            <header className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
                <p className="text-muted-foreground">{t('intro')}</p>
            </header>

            <section className="space-y-2">
                <h2 className="text-xl font-semibold">{t('notDoTitle')}</h2>
                <p className="text-muted-foreground">
                    {t.rich('notDoBody', {
                        code: function code(chunks) {
                            return <code>{chunks}</code>
                        }
                    })}
                </p>
            </section>

            <section className="space-y-2">
                <h2 className="text-xl font-semibold">{t('whoTitle')}</h2>
                <p className="text-muted-foreground">
                    {t.rich('whoBody', {
                        company: function company(chunks) {
                            return (
                                <a href="https://walkofcode.io" target="_blank" rel="noopener noreferrer">
                                    {chunks}
                                </a>
                            )
                        },
                        linkedin: function linkedin(chunks) {
                            return (
                                <a href="https://www.linkedin.com/in/sebastian-arena/" target="_blank" rel="noopener noreferrer">
                                    {chunks}
                                </a>
                            )
                        }
                    })}
                </p>
            </section>

            <section className="space-y-2">
                <h2 className="text-xl font-semibold">{t('advisoryTitle')}</h2>
                <p className="text-muted-foreground">
                    {t.rich('advisoryBody', {
                        code: function code(chunks) {
                            return <code>{chunks}</code>
                        }
                    })}
                </p>
            </section>

            <section className="space-y-3">
                <h2 className="text-xl font-semibold">{t('sendsTitle')}</h2>
                <NetworkActivityTable />
            </section>

            <section className="space-y-2">
                <h2 className="text-xl font-semibold">{t('dataLivesTitle')}</h2>
                <p className="text-muted-foreground">
                    {t.rich('dataLivesBody', {
                        code: function code(chunks) {
                            return <code>{chunks}</code>
                        }
                    })}
                </p>
            </section>

            <section className="space-y-2">
                <h2 className="text-xl font-semibold">{t('builtWithTitle')}</h2>
                <p className="text-muted-foreground">{BUILT_WITH.join(' · ')}</p>
            </section>

            <section className="space-y-2">
                <h2 className="text-xl font-semibold">{t('reportingTitle')}</h2>
                <p className="text-muted-foreground">
                    {t.rich('reportingBody', {
                        email: function email(chunks) {
                            return <a href="mailto:info@sentinello.org">{chunks}</a>
                        },
                        advisories: function advisories(chunks) {
                            return (
                                <a href="https://github.com/walkofcode/sentinello/security/advisories" target="_blank" rel="noopener noreferrer">
                                    {chunks}
                                </a>
                            )
                        }
                    })}
                </p>
            </section>

            <section className="space-y-2">
                <h2 className="text-xl font-semibold">{t('contributingTitle')}</h2>
                <p className="text-muted-foreground">
                    {t.rich('contributingBody', {
                        github: function github(chunks) {
                            return (
                                <a href="https://github.com/walkofcode/sentinello" target="_blank" rel="noopener noreferrer">
                                    {chunks}
                                </a>
                            )
                        }
                    })}
                </p>
            </section>

            <section className="space-y-2">
                <h2 className="text-xl font-semibold">{t('versionTitle')}</h2>
                <p className="text-muted-foreground">
                    {t('running', { version: info.current })}
                    {info.updateAvailable && info.latest && (
                        <>
                            {' — '}
                            <a href={info.releaseUrl || 'https://github.com/walkofcode/sentinello/releases'} target="_blank" rel="noopener noreferrer">
                                {t('versionAvailable', { version: info.latest })}
                            </a>
                        </>
                    )}
                </p>
            </section>

            <WhatsNewHistory />

            <section className="space-y-2 border-t pt-6 text-sm text-muted-foreground">
                <p>
                    {t.rich('legalNotice', {
                        terms: function terms(chunks) {
                            return <Link href="/legal/terms">{chunks}</Link>
                        },
                        privacy: function privacy(chunks) {
                            return <Link href="/legal/privacy">{chunks}</Link>
                        },
                        disclaimer: function disclaimer(chunks) {
                            return <Link href="/legal/disclaimer">{chunks}</Link>
                        },
                        license: function license(chunks) {
                            return (
                                <a href="https://github.com/walkofcode/sentinello/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">
                                    {chunks}
                                </a>
                            )
                        }
                    })}
                </p>
            </section>
        </div>
    )
}
