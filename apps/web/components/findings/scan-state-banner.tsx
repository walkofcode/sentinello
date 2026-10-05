import { getTranslations } from 'next-intl/server'
import { AlertTriangle } from 'lucide-react'
import { groupScanReasons, type Locale, type ScanState } from '@sentinello/core'
import { Badge } from '@/components/ui/badge'

type Props = {
    scanState: ScanState
    locale: Locale
}

// "Project cannot be scanned" / "Project cannot be fully scanned", above the findings, with every reason
// and whose side it is on: the project's (a file in it stops it from being read) or this install's (the
// operator's fix). A reason several sources share — no lockfile stops npm audit, OSV and the npm
// dependency read alike — is listed once, naming them all. Nothing is shown for a fully scanned project,
// nor for one never scanned, which the header already says.
export async function ScanStateBanner({ scanState, locale }: Props) {
    if (scanState.state !== 'cannot_scan' && scanState.state !== 'partial') return null
    const t = await getTranslations('Detail')
    const cannot = scanState.state === 'cannot_scan'
    return (
        <section
            data-testid="scan-state-banner"
            className={cannot
                ? 'space-y-3 rounded-(--radius-card) border border-destructive/40 bg-destructive/5 p-4'
                : 'space-y-3 rounded-(--radius-card) border border-amber-500/30 bg-amber-500/5 p-4'}
        >
            <div className="flex items-center gap-2">
                <AlertTriangle className={cannot ? 'h-4 w-4 text-destructive' : 'h-4 w-4 text-amber-600 dark:text-amber-400'} aria-hidden="true" />
                <h2 className="text-sm font-semibold">{cannot ? t('project.cannotScanTitle') : t('project.partialScanTitle')}</h2>
            </div>
            <p className="text-xs text-muted-foreground">{cannot ? t('project.cannotScanBody') : t('project.partialScanBody')}</p>
            <ul className="space-y-2">
                {groupScanReasons(scanState.reasons, locale).map(function reasonRow(group) {
                    let whose = t('project.scanReasonNotYetRun')
                    if (group.side === 'project') whose = t('project.scanReasonSideProject')
                    else if (group.side === 'environment') whose = t('project.scanReasonSideEnvironment')
                    return (
                        <li key={group.reasonCode + '|' + (group.side ?? '')} className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="font-medium">{group.label}</span>
                            {group.subjects.map(function subject(name) {
                                return <Badge key={name} variant="outline">{name}</Badge>
                            })}
                            <span className="text-muted-foreground">— {whose}</span>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
