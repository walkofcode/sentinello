import { useTranslations } from 'next-intl'
import { FolderTree, ScrollText, ShieldCheck, Terminal } from 'lucide-react'
import { CLI_DOCS_URL, NPX_COMMAND, NPX_PIPE_COMMAND } from '@/lib/links'
import { CopyBlock } from '@/components/ui/copy-block'
import { Section } from './section'

// The three things the CLI does, in the order it does them. Icons only — copy lives in the Cli catalog.
const STEPS = [
    { key: 'walk', Icon: FolderTree },
    { key: 'check', Icon: ShieldCheck },
    { key: 'write', Icon: ScrollText }
]

// Rows contrast `npm audit` with the CLI. Deliberately framed as "npm audit is one of the three sources"
// rather than as a benchmark: the interesting claim is coverage, and a findings count from any one
// repository would not generalise.
const CONTRASTS = ['scope', 'sources', 'malware', 'output', 'matching']

export function Cli() {
    const t = useTranslations('Cli')
    return (
        <Section id="cli">
            <div className="flex items-center gap-2.5">
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <Terminal className="h-4 w-4" />
                </span>
                <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
            </div>
            <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{t('subtitle')}</p>

            <div className="mt-8 max-w-2xl">
                <CopyBlock code={NPX_COMMAND} />
                <p className="mt-4 text-sm text-muted-foreground">{t('pipeCaption')}</p>
                <CopyBlock className="mt-2" code={NPX_PIPE_COMMAND} />
            </div>

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
                {STEPS.map(function step({ key, Icon }) {
                    return (
                        <div key={key} className="rounded-card border bg-card p-5">
                            <div className="flex items-center gap-2.5">
                                <Icon className="h-4 w-4 shrink-0 text-primary" />
                                <h3 className="text-sm font-semibold">{t(key + 'Title')}</h3>
                            </div>
                            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(key + 'Body')}</p>
                        </div>
                    )
                })}
            </div>

            <h3 className="mt-14 text-xl font-semibold tracking-tight">{t('vsTitle')}</h3>
            <p className="mt-3 max-w-3xl text-muted-foreground">{t('vsIntro')}</p>
            <div className="mt-6 overflow-x-auto">
                <table className="w-full min-w-[36rem] border-collapse text-sm">
                    <thead>
                        <tr className="border-b">
                            <th className="w-1/5 px-3 py-3 text-left font-medium text-muted-foreground">{t('vsAxis')}</th>
                            <th className="px-3 py-3 text-left font-semibold text-muted-foreground">{t('vsNpmAudit')}</th>
                            <th className="px-3 py-3 text-left font-semibold text-foreground">{t('vsSentinello')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {CONTRASTS.map(function row(key) {
                            return (
                                <tr key={key} className="border-b last:border-b-0">
                                    <td className="px-3 py-3 align-top text-foreground/90">{t('row_' + key)}</td>
                                    <td className="px-3 py-3 align-top text-muted-foreground">{t('npm_' + key)}</td>
                                    <td className="bg-primary/5 px-3 py-3 align-top text-foreground/90">{t('ours_' + key)}</td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>

            <p className="mt-6 max-w-3xl text-sm leading-relaxed text-muted-foreground">{t('footnote')}</p>
            <div className="mt-8">
                <a
                    href={CLI_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-md border px-7 text-base font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                    {t('docsCta')}
                </a>
            </div>
        </Section>
    )
}
