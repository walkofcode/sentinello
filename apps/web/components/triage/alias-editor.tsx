'use client'

import { useState, useTransition, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/input'
import { setProjectAliasAction } from '@/lib/actions/alias'

type Props = {
    projectId: string
    folderName: string
    currentAlias: string | null
    iconOnly?: boolean
}

export function AliasEditor({ projectId, folderName, currentAlias, iconOnly }: Props) {
    const t = useTranslations('Triage')
    const tc = useTranslations('Common')
    const [open, setOpen] = useState(false)
    const [value, setValue] = useState(currentAlias || '')
    const [pending, startTransition] = useTransition()
    function submit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault()
        startTransition(async function persist() {
            await setProjectAliasAction(projectId, value)
            setOpen(false)
        })
    }
    function close() {
        setValue(currentAlias || '')
        setOpen(false)
    }
    return (
        <>
            {iconOnly ? (
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={function show() { setOpen(true) }}
                    aria-label={t('alias.editName')}
                    title={t('alias.editName')}
                >
                    <Pencil className="h-4 w-4" />
                </Button>
            ) : (
                <Button variant="outline" onClick={function show() { setOpen(true) }}>
                    <Pencil className="h-4 w-4" />
                    {t('alias.editName')}
                </Button>
            )}
            <Dialog
                open={open}
                onClose={close}
                title={t('alias.title')}
                description={t('alias.description')}
                className="max-w-md"
            >
                <form onSubmit={submit} className="space-y-4 p-6">
                    <div className="flex flex-col gap-1">
                        <Label htmlFor="alias">{t('alias.label')}</Label>
                        <Input
                            id="alias"
                            value={value}
                            onChange={function onChange(e) { setValue(e.target.value) }}
                            placeholder={folderName}
                            autoFocus
                        />
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={close}>
                            {tc('cancel')}
                        </Button>
                        <Button type="submit" disabled={pending}>
                            {pending ? tc('saving') : tc('save')}
                        </Button>
                    </div>
                </form>
            </Dialog>
        </>
    )
}
