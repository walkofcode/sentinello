'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { loginAction, type LoginState } from './actions'

const initialState: LoginState = {}

export function LoginForm({ next }: { next: string }) {
    const t = useTranslations('Login')
    const [state, formAction, pending] = useActionState(loginAction, initialState)
    return (
        <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="next" value={next} />
            <div className="flex flex-col gap-1">
                <Label htmlFor="token">{t('accessToken')}</Label>
                <Input
                    id="token"
                    name="token"
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    required
                />
            </div>
            {state.error ? (
                <p className="text-sm text-destructive">{t('wrongToken')}</p>
            ) : null}
            <Button type="submit" disabled={pending}>
                {pending ? t('signingIn') : t('signIn')}
            </Button>
        </form>
    )
}
