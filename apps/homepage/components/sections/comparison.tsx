import { useTranslations } from 'next-intl'
import { Check, Minus } from 'lucide-react'
import { Section } from './section'

// Rows are the axes Sentinello is compared on; the three competitor columns plus Sentinello. Each cell
// is one of 'yes' | 'no' | 'partial', rendered as an icon + a short localized note. The data is static
// (positioning, not a live feature matrix) so it lives inline; copy comes from the Comparison catalog.
type Cell = 'yes' | 'no' | 'partial' | 'planned'

const COLUMNS = ['sentinello', 'depTrack', 'snyk', 'dependabot'] as const
type Column = (typeof COLUMNS)[number]

const ROWS: { key: string; cells: Record<Column, Cell> }[] = [
    { key: 'zeroConfig', cells: { sentinello: 'yes', depTrack: 'no', snyk: 'partial', dependabot: 'partial' } },
    { key: 'noSbom', cells: { sentinello: 'yes', depTrack: 'no', snyk: 'yes', dependabot: 'yes' } },
    { key: 'realLockfiles', cells: { sentinello: 'yes', depTrack: 'partial', snyk: 'yes', dependabot: 'yes' } },
    { key: 'malware', cells: { sentinello: 'yes', depTrack: 'no', snyk: 'yes', dependabot: 'no' } },
    { key: 'selfHosted', cells: { sentinello: 'yes', depTrack: 'yes', snyk: 'no', dependabot: 'no' } },
    { key: 'singleBinary', cells: { sentinello: 'yes', depTrack: 'no', snyk: 'no', dependabot: 'no' } },
    { key: 'aiNative', cells: { sentinello: 'yes', depTrack: 'no', snyk: 'partial', dependabot: 'no' } },
    { key: 'polyglot', cells: { sentinello: 'yes', depTrack: 'yes', snyk: 'yes', dependabot: 'yes' } },
    { key: 'enterprisePolicy', cells: { sentinello: 'partial', depTrack: 'yes', snyk: 'yes', dependabot: 'partial' } }
]

export function Comparison() {
    const t = useTranslations('Comparison')
    return (
        <Section id="comparison">
            <h2 className="text-3xl font-bold tracking-tight">{t('title')}</h2>
            <p className="mt-4 max-w-2xl text-lg text-muted-foreground">{t('subtitle')}</p>
            <div className="mt-10 overflow-x-auto">
                <table className="w-full min-w-[42rem] border-collapse text-sm">
                    <thead>
                        <tr className="border-b">
                            <th className="px-3 py-3 text-left font-medium text-muted-foreground">{t('axis')}</th>
                            {COLUMNS.map(function head(col) {
                                const isUs = col === 'sentinello'
                                return (
                                    <th
                                        key={col}
                                        className={
                                            'px-3 py-3 text-center font-semibold ' +
                                            (isUs ? 'text-foreground' : 'text-muted-foreground')
                                        }
                                    >
                                        {t('col_' + col)}
                                    </th>
                                )
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {ROWS.map(function row({ key, cells }) {
                            return (
                                <tr key={key} className="border-b last:border-b-0">
                                    <td className="px-3 py-3 text-foreground/90">{t('row_' + key)}</td>
                                    {COLUMNS.map(function cell(col) {
                                        const isUs = col === 'sentinello'
                                        return (
                                            <td key={col} className={'px-3 py-3 text-center ' + (isUs ? 'bg-primary/5' : '')}>
                                                <CellMark value={cells[col]} plannedLabel={t('planned')} />
                                            </td>
                                        )
                                    })}
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
            <p className="mt-6 max-w-3xl text-sm leading-relaxed text-muted-foreground">{t('footnote')}</p>
        </Section>
    )
}

function CellMark({ value, plannedLabel }: { value: Cell; plannedLabel: string }) {
    if (value === 'yes') {
        return <Check className="mx-auto h-4 w-4 text-success" aria-label="yes" />
    }
    if (value === 'planned') {
        return (
            <span className="inline-block rounded-full border border-primary/40 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wider text-primary">
                {plannedLabel}
            </span>
        )
    }
    if (value === 'partial') {
        return <span className="text-xs font-medium text-muted-foreground" aria-label="partial">~</span>
    }
    return <Minus className="mx-auto h-4 w-4 text-muted-foreground/40" aria-label="no" />
}
