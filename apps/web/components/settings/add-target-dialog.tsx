'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import type {
    DepTypeFilter,
    NotificationTargetConfig,
    NotificationTargetKind,
    Project,
    Root,
    Severity,
    WebhookFlavor
} from '@sentinello/core'
import { upsertNotificationTargetAction } from '@/lib/actions/settings'
import { RootScopeField, type RootScopeMode } from '@/components/settings/root-scope-field'
import { SeverityFilterPills } from '@/components/settings/severity-filter-pills'
import { EnvFilterField } from '@/components/settings/env-filter-field'

type Props = {
    open: boolean
    onClose: () => void
    roots: Root[]
    projects: Project[]
}

export function AddTargetDialog({ open, onClose, roots, projects }: Props) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const [kind, setKind] = useState<NotificationTargetKind>('slack')
    const [slackUrl, setSlackUrl] = useState('')
    const [botToken, setBotToken] = useState('')
    const [chatId, setChatId] = useState('')
    const [webhookUrl, setWebhookUrl] = useState('')
    const [webhookFlavor, setWebhookFlavor] = useState<WebhookFlavor>('json')
    const [enabled, setEnabled] = useState(true)
    const [filter, setFilter] = useState<Severity[]>(['critical', 'high'])
    const [envFilter, setEnvFilter] = useState<DepTypeFilter>('all')
    // Default to "everything" so new targets keep the historical app-wide behaviour unless the
    // operator explicitly narrows scope. This also means existing operators don't have to learn
    // a new field to add a new target.
    const [scopeMode, setScopeMode] = useState<RootScopeMode>('all')
    const [selectedRootIds, setSelectedRootIds] = useState<string[]>([])
    const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([])
    const [pending, startTransition] = useTransition()
    function toggleSeverity(sev: Severity) {
        setFilter(function next(prev) {
            if (prev.includes(sev)) return prev.filter(function notSev(s) { return s !== sev })
            return [...prev, sev]
        })
    }
    function reset() {
        setKind('slack')
        setSlackUrl('')
        setBotToken('')
        setChatId('')
        setWebhookUrl('')
        setWebhookFlavor('json')
        setEnabled(true)
        setFilter(['critical', 'high'])
        setEnvFilter('all')
        setScopeMode('all')
        setSelectedRootIds([])
        setSelectedProjectIds([])
    }
    const scopeInvalid = scopeMode === 'selected' && selectedRootIds.length === 0 && selectedProjectIds.length === 0
    function submit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        if (scopeInvalid) return
        startTransition(async function persist() {
            const config: NotificationTargetConfig =
                kind === 'slack'
                    ? { webhookUrl: slackUrl }
                    : kind === 'telegram'
                        ? { botToken, chatId }
                        : { url: webhookUrl, flavor: webhookFlavor }
            const rootIds = scopeMode === 'all' ? [] : selectedRootIds
            const projectIds = scopeMode === 'all' ? [] : selectedProjectIds
            await upsertNotificationTargetAction({
                kind,
                config,
                severityFilter: filter,
                envFilter,
                enabled,
                rootIds,
                projectIds
            })
            reset()
            onClose()
        })
    }
    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={t('notifications.dialog.title')}
            description={t('notifications.dialog.description')}
        >
            <form onSubmit={submit} className="flex flex-1 flex-col overflow-hidden">
                <div className="space-y-4 overflow-y-auto px-6 py-4">
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={enabled}
                            onChange={function onChange(e) { setEnabled(e.target.checked) }}
                            className="h-4 w-4"
                        />
                        {t('notifications.enabled')}
                    </label>
                    <div className="flex flex-col gap-1 sm:w-64">
                        <Label htmlFor="kind">{t('notifications.kind')}</Label>
                        <Select
                            id="kind"
                            value={kind}
                            onChange={function onChange(e) { setKind(e.target.value as NotificationTargetKind) }}
                        >
                            <option value="slack">Slack</option>
                            <option value="telegram">Telegram</option>
                            <option value="webhook">{t('notifications.genericWebhook')}</option>
                        </Select>
                    </div>
                    {kind === 'slack' ? (
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="slack-url">{t('notifications.slackUrlLabel')}</Label>
                            <Input
                                id="slack-url"
                                value={slackUrl}
                                onChange={function onChange(e) { setSlackUrl(e.target.value) }}
                                placeholder="https://hooks.slack.com/services/T00/B00/abcd  (or env:SLACK_URL)"
                                required
                            />
                        </div>
                    ) : null}
                    {kind === 'telegram' ? (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="flex flex-col gap-1">
                                <Label htmlFor="bot-token">{t('notifications.botToken')}</Label>
                                <Input
                                    id="bot-token"
                                    value={botToken}
                                    onChange={function onChange(e) { setBotToken(e.target.value) }}
                                    placeholder="123456:AAFqB...   (or env:TG_BOT)"
                                    required
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <Label htmlFor="chat-id">{t('notifications.chatId')}</Label>
                                <Input
                                    id="chat-id"
                                    value={chatId}
                                    onChange={function onChange(e) { setChatId(e.target.value) }}
                                    placeholder="−1001234567890"
                                    required
                                />
                            </div>
                        </div>
                    ) : null}
                    {kind === 'webhook' ? (
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                                <Label htmlFor="webhook-url">{t('notifications.webhookUrl')}</Label>
                                <Input
                                    id="webhook-url"
                                    value={webhookUrl}
                                    onChange={function onChange(e) { setWebhookUrl(e.target.value) }}
                                    placeholder="https://example.com/hook  (or env:HOOK_URL)"
                                    required
                                />
                            </div>
                            <div className="flex flex-col gap-1 sm:w-64">
                                <Label htmlFor="webhook-flavor">{t('notifications.webhookFlavor')}</Label>
                                <Select
                                    id="webhook-flavor"
                                    value={webhookFlavor}
                                    onChange={function onChange(e) { setWebhookFlavor(e.target.value as WebhookFlavor) }}
                                >
                                    <option value="json">{t('notifications.webhookFlavorJson')}</option>
                                    <option value="text">{t('notifications.webhookFlavorText')}</option>
                                </Select>
                                <p className="text-xs text-muted-foreground">{t('notifications.webhookFlavorHelp')}</p>
                            </div>
                        </div>
                    ) : null}
                    <div className="flex flex-col gap-2">
                        <Label>{t('notifications.severityFilter')}</Label>
                        <SeverityFilterPills value={filter} onToggle={toggleSeverity} disabled={pending} />
                    </div>
                    <EnvFilterField value={envFilter} onChange={setEnvFilter} disabled={pending} />
                    <RootScopeField
                        id="add-target"
                        roots={roots}
                        projects={projects}
                        mode={scopeMode}
                        selectedRootIds={selectedRootIds}
                        selectedProjectIds={selectedProjectIds}
                        onModeChange={setScopeMode}
                        onSelectedRootsChange={setSelectedRootIds}
                        onSelectedProjectsChange={setSelectedProjectIds}
                        disabled={pending}
                    />
                </div>
                <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-6 py-4">
                    <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                        {tc('cancel')}
                    </Button>
                    <Button type="submit" disabled={pending || scopeInvalid}>
                        <Plus className="h-4 w-4" />
                        {pending ? t('notifications.adding') : t('notifications.addButton')}
                    </Button>
                </div>
            </form>
        </Dialog>
    )
}
