'use client'

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { scanReasonLabel, type FixFields, type Locale, type NotRecheckedBecause } from '@sentinello/core'
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
    const notRechecked = fix.notRecheckedBecause ?? null
    return (
        <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 text-xs">
                <span className="font-mono">{installed || '—'}</span>
                <span className="text-muted-foreground">→</span>
                <FixTarget fix={fix} />
            </div>
            {/* A settled row retained by a failed scan keeps its answer, as of the scan that settled it,
                and says it was not re-checked since. */}
            {notRechecked !== null && fix.fixCheck !== null ? <NotRechecked reason={notRechecked} /> : null}
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
    // A row no settlement has written: its old value is withheld, not shown as the advisory's. When its
    // project cannot be scanned, a rescan would change nothing — that is said instead of "rescan pending".
    if (fix.fixCheck === null) {
        if (fix.notRecheckedBecause) return <NotRechecked reason={fix.notRecheckedBecause} />
        return <span className="text-muted-foreground">{t('fixRecheckPending')}</span>
    }
    if (fix.fixVersion) {
        return <span className="text-muted-foreground">{t('fixStatedUnverified', { version: fix.fixVersion })}</span>
    }
    if (fix.fixAvailable) return <span className="text-muted-foreground">{t('fixAvailableSeeAdvisory')}</span>
    return <span className="text-muted-foreground">{t('fixUnverified')}</span>
}

// "not re-checked — the project cannot be scanned: No lockfile (last scanned successfully Oct 1, 2026)".
export function NotRechecked({ reason }: { reason: NotRecheckedBecause }) {
    const t = useTranslations('Findings')
    const locale = useLocale() as Locale
    const format = useFormatter()
    const label = scanReasonLabel(reason, locale)
    const text = reason.projectState === 'cannot_scan' ? t('notRecheckedCannotScan', { reason: label }) : t('notRecheckedPartial', { reason: label })
    const when = reason.lastOkScanAt === null
        ? t('neverScannedSuccessfully')
        : t('lastScannedSuccessfully', { date: format.dateTime(new Date(reason.lastOkScanAt), { dateStyle: 'medium' }) })
    return <span data-testid="not-rechecked" className="text-[0.625rem] text-amber-700 dark:text-amber-400">{text} ({when})</span>
}
