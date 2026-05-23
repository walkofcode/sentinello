'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'

type Props = {
    installed: string
    fix: string | null
    vulnerableRange: string
    fixAvailable: boolean
    className?: string
}

export function VersionChain({ installed, fix, vulnerableRange, fixAvailable }: Props) {
    const t = useTranslations('Findings')
    return (
        <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 text-xs">
                <span className="font-mono">{installed || '—'}</span>
                <span className="text-muted-foreground">→</span>
                {fixAvailable && fix ? (
                    <Badge variant="default" className="font-mono">{fix}</Badge>
                ) : (
                    <span className="text-muted-foreground">
                        {fixAvailable ? t('fixAvailableSeeAdvisory') : t('noPatchPublished')}
                    </span>
                )}
            </div>
            {vulnerableRange ? (
                <div className="font-mono text-[0.625rem] text-muted-foreground">
                    {t('vulnPrefix')} {vulnerableRange}
                </div>
            ) : null}
        </div>
    )
}
