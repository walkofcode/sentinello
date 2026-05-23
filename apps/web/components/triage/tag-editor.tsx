'use client'

import { useState, useTransition, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/input'
import { setProjectTagsAction } from '@/lib/actions/tag'

type Props = {
    projectId: string
    initialTags: string[]
}

export function TagEditor({ projectId, initialTags }: Props) {
    const t = useTranslations('Triage')
    const tc = useTranslations('Common')
    const initial = initialTags.join(', ')
    const [open, setOpen] = useState(false)
    const [value, setValue] = useState(initial)
    const [pending, startTransition] = useTransition()
    function submit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault()
        startTransition(async function persist() {
            await setProjectTagsAction(projectId, value)
            setOpen(false)
        })
    }
    function close() {
        setValue(initial)
        setOpen(false)
    }
    return (
        <>
            <Button variant="outline" onClick={function show() { setOpen(true) }}>
                <Tag className="h-4 w-4" />
                {t('tags.editTags')}
            </Button>
            <Dialog
                open={open}
                onClose={close}
                title={t('tags.title')}
                description={t('tags.description')}
                className="max-w-md"
            >
                <form onSubmit={submit} className="space-y-4 p-6">
                    <div className="flex flex-col gap-1">
                        <Label htmlFor="tags">{t('tags.label')}</Label>
                        <Input
                            id="tags"
                            value={value}
                            onChange={function onChange(e) { setValue(e.target.value) }}
                            placeholder={t('tags.placeholder')}
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
