'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { loginAction, type LoginState } from './actions'

const initialState: LoginState = {}

export function LoginForm({ next }: { next: string }) {
    const [state, formAction, pending] = useActionState(loginAction, initialState)
    return (
        <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="next" value={next} />
            <div className="flex flex-col gap-1">
                <Label htmlFor="token">Access token</Label>
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
                <p className="text-sm text-destructive">That token didn&apos;t match. Try again.</p>
            ) : null}
            <Button type="submit" disabled={pending}>
                {pending ? 'Signing in…' : 'Sign in'}
            </Button>
        </form>
    )
}
