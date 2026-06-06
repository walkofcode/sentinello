'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Label, Textarea } from '@/components/ui/input'
import { Dropdown } from '@/components/ui/dropdown'
import { locales, LOCALE_LABELS } from '@/i18n/config'
import { updateAdvancedSettingsAction } from '@/lib/actions/settings'

type RootOption = {
    id: string
    path: string
    label: string | null
}

type Props = {
    initial: {
        parallelism: number
        watcherEnabled: boolean
        watcherRoots: string[]
        globalIgnore: string[]
        dryRunNotify: boolean
        portalBaseUrl: string
        notificationLocale: string
    }
    roots: RootOption[]
}

export function AdvancedForm({ initial, roots }: Props) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const [parallelism, setParallelism] = useState(initial.parallelism.toString())
    const [watcherEnabled, setWatcherEnabled] = useState(initial.watcherEnabled)
    const [watcherRoots, setWatcherRoots] = useState<string[]>(initial.watcherRoots)
    const [globalIgnore, setGlobalIgnore] = useState(initial.globalIgnore.join('\n'))
    const [dryRunNotify, setDryRunNotify] = useState(initial.dryRunNotify)
    const [portalBaseUrl, setPortalBaseUrl] = useState(initial.portalBaseUrl)
    const [notificationLocale, setNotificationLocale] = useState(initial.notificationLocale)
    const [pending, startTransition] = useTransition()
    function toggleWatcherRoot(rootPath: string) {
        setWatcherRoots(function next(prev) {
            if (prev.includes(rootPath)) return prev.filter(function notPath(p) { return p !== rootPath })
            return [...prev, rootPath]
        })
    }
    function submit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        startTransition(async function persist() {
            const ignoreLines = globalIgnore
                .split('\n')
                .map(function trim(l) { return l.trim() })
                .filter(function nonEmpty(l) { return l.length > 0 })
            await updateAdvancedSettingsAction({
                parallelism: Number(parallelism) || 4,
                watcherEnabled,
                watcherRoots,
                globalIgnore: ignoreLines,
                dryRunNotify,
                portalBaseUrl,
                notificationLocale
            })
        })
    }
    return (
        <form onSubmit={submit} className="space-y-6 rounded-(--radius-card) border bg-card p-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-1">
                    <Label htmlFor="parallelism">{t('advanced.concurrentScans')}</Label>
                    <Input
                        id="parallelism"
                        type="number"
                        min={1}
                        max={64}
                        value={parallelism}
                        onChange={function onChange(e) { setParallelism(e.target.value) }}
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <Label htmlFor="portal-base-url">{t('advanced.portalBaseUrl')}</Label>
                    <Input
                        id="portal-base-url"
                        value={portalBaseUrl}
                        onChange={function onChange(e) { setPortalBaseUrl(e.target.value) }}
                        placeholder="https://sentinello.example.com"
                    />
                </div>
                <div className="flex flex-col gap-1">
                    <Label htmlFor="notification-locale">{t('advanced.notificationLanguage')}</Label>
                    <Dropdown
                        id="notification-locale"
                        className="w-full"
                        ariaLabel={t('advanced.notificationLanguage')}
                        value={notificationLocale}
                        onChange={setNotificationLocale}
                        options={locales.map(function localeOption(code) {
                            return { value: code, label: LOCALE_LABELS[code] }
                        })}
                    />
                    <p className="text-xs text-muted-foreground">{t('advanced.notificationLanguageHelp')}</p>
                </div>
            </div>
            <div className="flex flex-col gap-1">
                <Label htmlFor="ignore">{t('advanced.globalIgnore')}</Label>
                <Textarea
                    id="ignore"
                    rows={6}
                    value={globalIgnore}
                    onChange={function onChange(e) { setGlobalIgnore(e.target.value) }}
                    placeholder={'node_modules\n.git\ndist\n.next'}
                />
            </div>
            <div className="space-y-3">
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={watcherEnabled}
                        onChange={function onChange(e) { setWatcherEnabled(e.target.checked) }}
                        className="h-4 w-4"
                    />
                    {t('advanced.watcherLabel')}
                </label>
                {watcherEnabled ? (
                    <div className="ml-6 flex flex-col gap-2">
                        <Label>{t('advanced.watchedRoots')}</Label>
                        {roots.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                                {t('advanced.noRoots')}
                            </p>
                        ) : (
                            <ul className="space-y-1">
                                {roots.map(function rootRow(root) {
                                    const checked = watcherRoots.includes(root.path)
                                    return (
                                        <li key={root.id}>
                                            <label className="flex cursor-pointer items-center gap-2 text-sm">
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={function onChange() { toggleWatcherRoot(root.path) }}
                                                    className="h-4 w-4"
                                                />
                                                <span className="font-medium">{root.label || root.path}</span>
                                                {root.label ? (
                                                    <span className="font-mono text-xs text-muted-foreground">{root.path}</span>
                                                ) : null}
                                            </label>
                                        </li>
                                    )
                                })}
                            </ul>
                        )}
                        <p className="text-xs text-muted-foreground">
                            {t('advanced.emptySelectionHelp')}
                        </p>
                    </div>
                ) : null}
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={dryRunNotify}
                        onChange={function onChange(e) { setDryRunNotify(e.target.checked) }}
                        className="h-4 w-4"
                    />
                    {t('advanced.dryRunLabel')}
                </label>
            </div>
            <div className="flex justify-end">
                <Button type="submit" disabled={pending}>
                    <Save className="h-4 w-4" />
                    {pending ? tc('saving') : t('advanced.saveButton')}
                </Button>
            </div>
        </form>
    )
}
