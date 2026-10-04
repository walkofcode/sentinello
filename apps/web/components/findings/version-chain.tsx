'use client'

import { useTranslations } from 'next-intl'
import type { FixFields } from '@sentinello/core'
import { Badge } from '@/components/ui/badge'

type Props = {
    installed: string
    vulnerableRange: string
    // The settled fix (readFixFields). Only a `released` version is shown as the badge to upgrade to.
    fix: FixFields
    className?: string
}

export function VersionChain({ installed, vulnerableRange, fix }: Props) {
    const t = useTranslations('Findings')
    return (
        <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 text-xs">
                <span className="font-mono">{installed || '—'}</span>
                <span className="text-muted-foreground">→</span>
                <FixTarget fix={fix} />
            </div>
            {vulnerableRange ? (
                <div className="font-mono text-[0.625rem] text-muted-foreground">
                    {t('vulnPrefix')} {vulnerableRange}
                </div>
            ) : null}
        </div>
    )
}

function FixTarget({ fix }: { fix: FixFields }) {
    const t = useTranslations('Findings')
    if (fix.fixStatus === 'released' && fix.fixVersion) {
        return <Badge variant="default" className="font-mono">{fix.fixVersion}</Badge>
    }
    if (fix.fixStatus === 'none_released') {
        return <span className="font-medium text-destructive">{t('noFixReleased')}</span>
    }
    // A row no settlement has written: its old value is withheld, not shown as the advisory's.
    if (fix.fixCheck === null) return <span className="text-muted-foreground">{t('fixRecheckPending')}</span>
    if (fix.fixVersion) {
        return <span className="text-muted-foreground">{t('fixStatedUnverified', { version: fix.fixVersion })}</span>
    }
    if (fix.fixAvailable) return <span className="text-muted-foreground">{t('fixAvailableSeeAdvisory')}</span>
    return <span className="text-muted-foreground">{t('fixUnverified')}</span>
}
