import { useTranslations } from 'next-intl'
import { Bell, Bot, Boxes, Container, FileDown, FolderGit2, Inbox, Languages, RefreshCw, ServerCog, ShieldAlert, type LucideIcon } from 'lucide-react'
import { Section } from './section'

const FEATURES: { key: string; Icon: LucideIcon }[] = [
    { key: 'queue', Icon: Inbox },
    { key: 'browse', Icon: FolderGit2 },
    { key: 'scanning', Icon: RefreshCw },
    { key: 'sources', Icon: ShieldAlert },
    { key: 'notifications', Icon: Bell },
    { key: 'mcp', Icon: Bot },
    { key: 'export', Icon: FileDown },
    { key: 'selfContained', Icon: Container },
    { key: 'autoRoots', Icon: Boxes },
    { key: 'nodeVersions', Icon: ServerCog },
    { key: 'languages', Icon: Languages }
]

export function Features() {
    const t = useTranslations('Features')
    return (
        <Section id="features">
            <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
            <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{t('subtitle')}</p>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {FEATURES.map(function feature({ key, Icon }) {
                    return (
                        <div key={key} className="rounded-card border bg-card p-5">
                            <div className="flex items-center gap-2.5">
                                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                                    <Icon className="h-4 w-4" />
                                </span>
                                <h3 className="text-sm font-semibold">{t(key + 'Title')}</h3>
                            </div>
                            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(key + 'Body')}</p>
                        </div>
                    )
                })}
            </div>
        </Section>
    )
}
