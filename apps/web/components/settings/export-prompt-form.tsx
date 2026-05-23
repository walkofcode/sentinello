'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { RotateCcw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label, Textarea } from '@/components/ui/input'
import { resetExportPromptAction, updateExportPromptAction } from '@/lib/actions/export'

type Props = {
    initialPrompt: string
    defaultPrompt: string
    isCustom: boolean
}

export function ExportPromptForm({ initialPrompt, defaultPrompt, isCustom }: Props) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const [prompt, setPrompt] = useState(initialPrompt)
    const [savedCustom, setSavedCustom] = useState(isCustom)
    const [savePending, startSave] = useTransition()
    const [resetPending, startReset] = useTransition()
    function submit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        startSave(async function persist() {
            await updateExportPromptAction(prompt)
            setSavedCustom(true)
        })
    }
    function resetToDefault() {
        startReset(async function clear() {
            await resetExportPromptAction()
            setPrompt(defaultPrompt)
            setSavedCustom(false)
        })
    }
    const isDirty = prompt !== initialPrompt
    return (
        <form onSubmit={submit} className="space-y-6 rounded-(--radius-card) border bg-card p-6">
            <div className="space-y-2">
                <h2 className="text-lg font-semibold">{t('export.title')}</h2>
                <p className="text-sm text-muted-foreground">
                    {t('export.description')}
                </p>
                <p className="text-xs text-muted-foreground">
                    {t.rich('export.currentlyUsing', {
                        value: function value() {
                            return <span className="font-medium">{savedCustom ? t('export.customPrompt') : t('export.defaultPrompt')}</span>
                        }
                    })}
                </p>
            </div>
            <div className="flex flex-col gap-1">
                <Label htmlFor="export-prompt">{t('export.promptBodyLabel')}</Label>
                <Textarea
                    id="export-prompt"
                    rows={24}
                    value={prompt}
                    onChange={function onChange(e) { setPrompt(e.target.value) }}
                    className="font-mono text-xs"
                />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                    type="button"
                    variant="outline"
                    onClick={resetToDefault}
                    disabled={resetPending || savePending}
                >
                    <RotateCcw className="h-4 w-4" />
                    {resetPending ? t('export.resetting') : t('export.resetButton')}
                </Button>
                <Button type="submit" disabled={savePending || resetPending || !isDirty}>
                    <Save className="h-4 w-4" />
                    {savePending ? tc('saving') : t('export.saveButton')}
                </Button>
            </div>
        </form>
    )
}
