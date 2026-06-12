import { getTranslations } from 'next-intl/server'
import { AlertTriangle } from 'lucide-react'
import { reasonCodeLabel, type Locale, type ReasonCode } from '@sentinello/core'
import type { EcosystemCoverageRow } from '@sentinello/db'
import { Badge } from '@/components/ui/badge'
import { EcosystemBadge } from './ecosystem-badge'

type Props = {
    coverage: EcosystemCoverageRow[]
    locale: Locale
}

// Surfaces per-ecosystem partial/unauditable resolver coverage (Phase 4) so a project that was only
// partially auditable for an ecosystem doesn't read as a clean bill of health. `ok` ecosystems are not
// shown — only gaps. Each row pairs the language badge with the coverage status and the localized reason.
export async function CoverageNotice({ coverage, locale }: Props) {
    const t = await getTranslations('Detail')
    const gaps = coverage.filter(function isGap(c) {
        return c.status !== 'ok'
    })
    if (gaps.length === 0) return null
    return (
        <section className="space-y-3 rounded-(--radius-card) border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <h2 className="text-sm font-semibold">{t('project.coverageTitle')}</h2>
            </div>
            <p className="text-xs text-muted-foreground">{t('project.coverageBody')}</p>
            <ul className="space-y-2">
                {gaps.map(function gapRow(c) {
                    const statusLabel = c.status === 'unauditable' ? t('project.coverageUnauditable') : t('project.coveragePartial')
                    return (
                        <li key={c.ecosystem} className="flex flex-wrap items-center gap-2 text-xs">
                            <EcosystemBadge ecosystem={c.ecosystem} />
                            <Badge variant={c.status === 'unauditable' ? 'high' : 'moderate'}>{statusLabel}</Badge>
                            {c.reasonCode ? (
                                <span className="text-muted-foreground">{reasonCodeLabel(c.reasonCode as ReasonCode, locale)}</span>
                            ) : null}
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
