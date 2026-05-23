'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'

type Props = {
    code: string
    className?: string
}

export function CopyBlock({ code, className }: Props) {
    const t = useTranslations('Common')
    const [copied, setCopied] = useState<boolean>(false)
    useEffect(function resetCopied() {
        if (!copied) return
        const id = setTimeout(function clear() { setCopied(false) }, 2000)
        return function cleanup() { clearTimeout(id) }
    }, [copied])
    async function copy() {
        try {
            await navigator.clipboard.writeText(code)
            setCopied(true)
        } catch {
            setCopied(false)
        }
    }
    return (
        <div className={cn('group relative rounded-card border bg-card text-card-foreground', className)}>
            <pre className="overflow-x-auto px-4 py-3.5 pr-12 font-mono text-xs leading-relaxed sm:text-sm">
                <code>{code}</code>
            </pre>
            <button
                onClick={copy}
                aria-label={t('copy')}
                title={(copied && t('copied')) || t('copy')}
                className="absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background/70 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </button>
        </div>
    )
}
