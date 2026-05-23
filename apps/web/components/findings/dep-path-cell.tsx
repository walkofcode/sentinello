'use client'

import { useTranslations } from 'next-intl'

type Props = {
    path: string[]
    className?: string
}

export function DepPathCell({ path, className }: Props) {
    const t = useTranslations('Findings')
    const base = 'font-mono text-xs text-muted-foreground'
    const cls = className ? base + ' ' + className : base
    if (path.length === 0) {
        return <span className={cls}>—</span>
    }
    if (path.length <= 2) {
        return <span className={cls}>{path.join(' → ')}</span>
    }
    const head = path[0]
    const tail = path[path.length - 1]
    const full = path.join(' → ')
    return (
        <span className={cls} title={full}>
            {head} → … → {tail} ({t('depPathLevels', { n: path.length })})
        </span>
    )
}
