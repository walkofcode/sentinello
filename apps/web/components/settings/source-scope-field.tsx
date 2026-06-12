'use client'

import { useTranslations } from 'next-intl'
import { ECOSYSTEMS, SOURCES, sourceSupportsEcosystem, type NotificationSourceScope, type SourceCell } from '@sentinello/core'
import { Label } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { EcosystemBadge } from '@/components/findings/ecosystem-badge'

// "Which (source, ecosystem) cells should this target fire for?" picker. Two modes:
//   - 'all'      : { mode: 'all', cells: [] } — fires for every cell (the historical behaviour).
//   - 'selected' : explicit allow-list of (source, ecosystem) cells, driven by the central registry so
//                  labels/ids match the Languages × Sources matrix. An empty selection in this mode is
//                  surfaced as a validation error by the parent.
// The parent owns the state so it can validate on submit and reset on cancel.

export type SourceScopeMode = NotificationSourceScope['mode']

type Props = {
    id: string
    mode: SourceScopeMode
    selectedCells: SourceCell[]
    onModeChange: (mode: SourceScopeMode) => void
    onSelectedCellsChange: (cells: SourceCell[]) => void
    disabled?: boolean
}

function hasCell(cells: SourceCell[], cell: SourceCell): boolean {
    return cells.some(function eq(c) { return c.source === cell.source && c.ecosystem === cell.ecosystem })
}

export function SourceScopeField(props: Props) {
    const t = useTranslations('Settings')
    const { id, mode, selectedCells, onModeChange, onSelectedCellsChange, disabled } = props
    function toggleCell(cell: SourceCell) {
        if (hasCell(selectedCells, cell)) {
            onSelectedCellsChange(selectedCells.filter(function notCell(c) {
                return !(c.source === cell.source && c.ecosystem === cell.ecosystem)
            }))
            return
        }
        onSelectedCellsChange([...selectedCells, cell])
    }
    const showSelectionError = mode === 'selected' && selectedCells.length === 0
    return (
        <div className="flex flex-col gap-2">
            <Label>{t('sourceScope.label')}</Label>
            <div className="flex flex-col gap-2 rounded-md border bg-card p-3">
                <label className="flex items-start gap-2 text-sm">
                    <input
                        type="radio"
                        name={'source-scope-mode-' + id}
                        checked={mode === 'all'}
                        onChange={function onChange() { onModeChange('all') }}
                        disabled={disabled}
                        className="mt-0.5 h-4 w-4"
                    />
                    <span>
                        <span className="font-medium">{t('sourceScope.all')}</span>
                        <span className="block text-xs text-muted-foreground">{t('sourceScope.allHelp')}</span>
                    </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                    <input
                        type="radio"
                        name={'source-scope-mode-' + id}
                        checked={mode === 'selected'}
                        onChange={function onChange() { onModeChange('selected') }}
                        disabled={disabled}
                        className="mt-0.5 h-4 w-4"
                    />
                    <span>
                        <span className="font-medium">{t('sourceScope.selected')}</span>
                        <span className="block text-xs text-muted-foreground">{t('sourceScope.selectedHelp')}</span>
                    </span>
                </label>
                {mode === 'selected' ? (
                    <div className="ml-6 flex flex-col gap-3 border-l pl-3">
                        {ECOSYSTEMS.map(function ecoBlock(eco) {
                            const cells = SOURCES.filter(function supports(s) {
                                return sourceSupportsEcosystem(s.id, eco.id)
                            })
                            return (
                                <div key={eco.id} className="flex flex-col gap-1">
                                    <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                        <EcosystemBadge ecosystem={eco.id} />
                                    </span>
                                    {cells.map(function sourceRow(s) {
                                        const cell: SourceCell = { source: s.id, ecosystem: eco.id }
                                        const checked = hasCell(selectedCells, cell)
                                        return (
                                            <label key={s.id} className="flex items-center gap-2 text-sm">
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={function onChange() { toggleCell(cell) }}
                                                    disabled={disabled}
                                                    className="h-4 w-4"
                                                />
                                                <Badge variant="muted">{s.displayName}</Badge>
                                            </label>
                                        )
                                    })}
                                </div>
                            )
                        })}
                    </div>
                ) : null}
                {showSelectionError ? (
                    <p className="text-xs text-destructive">{t('sourceScope.selectionError')}</p>
                ) : null}
            </div>
        </div>
    )
}

// "selected" iff the scope restricts to a non-empty cell list.
export function sourceScopeModeFrom(scope: NotificationSourceScope): SourceScopeMode {
    return scope.mode === 'selected' && scope.cells.length > 0 ? 'selected' : 'all'
}
