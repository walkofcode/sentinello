import { useTranslations } from 'next-intl'
import { Braces, FileText, FolderTree, MessageSquare, Send, Webhook, type LucideIcon } from 'lucide-react'
import { Section } from './section'

const CHANNELS: { key: string; Icon: LucideIcon }[] = [
    { key: 'slack', Icon: MessageSquare },
    { key: 'telegram', Icon: Send },
    { key: 'webhook', Icon: Webhook }
]

const FLAVORS: { key: string; Icon: LucideIcon }[] = [
    { key: 'json', Icon: Braces },
    { key: 'text', Icon: FileText }
]

export function Notifications() {
    const t = useTranslations('Notifications')
    return (
        <Section id="notifications">
            <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
            <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{t('subtitle')}</p>
            <div className="mt-10 grid gap-4 sm:grid-cols-3">
                {CHANNELS.map(function channel({ key, Icon }) {
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
            <h3 className="mt-12 text-xl font-semibold tracking-tight">{t('flavorsTitle')}</h3>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">{t('flavorsSubtitle')}</p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
                {FLAVORS.map(function flavor({ key, Icon }) {
                    return (
                        <div key={key} className="rounded-card border bg-card p-5">
                            <div className="flex items-center gap-2.5">
                                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                                    <Icon className="h-4 w-4" />
                                </span>
                                <h4 className="text-sm font-semibold">{t(key + 'Title')}</h4>
                            </div>
                            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(key + 'Body')}</p>
                        </div>
                    )
                })}
            </div>
            <div className="mt-8 flex max-w-3xl items-start gap-3 rounded-card border border-dashed bg-card/50 p-5">
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <FolderTree className="h-4 w-4" />
                </span>
                <div>
                    <h4 className="text-sm font-semibold">{t('scopeTitle')}</h4>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t('scopeBody')}</p>
                </div>
            </div>
        </Section>
    )
}
