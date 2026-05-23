'use client'

import { useTranslations } from 'next-intl'
import { Label } from '@/components/ui/input'

// Reusable "what does this target apply to?" picker. Two modes:
//   - 'all'      : empty selection in DB (zero root rows AND zero project rows) — fires for
//                  everything, current and future.
//   - 'selected' : explicit allow-list. The operator can pick whole roots and/or individual
//                  projects; the two lists are additive (an event matches if its root OR its project
//                  is selected). An empty selection in this mode is surfaced as a validation error by
//                  the parent (Save disabled with helper text).
// The parent owns the state so it can validate on submit and reset cleanly on cancel.

export type RootScopeMode = 'all' | 'selected'

type RootOption = {
    id: string
    path: string
    label: string | null
}

type ProjectOption = {
    id: string
    name: string
    alias: string | null
    relPath: string
}

type Props = {
    id: string
    roots: RootOption[]
    projects: ProjectOption[]
    mode: RootScopeMode
    selectedRootIds: string[]
    selectedProjectIds: string[]
    onModeChange: (mode: RootScopeMode) => void
    onSelectedRootsChange: (rootIds: string[]) => void
    onSelectedProjectsChange: (projectIds: string[]) => void
    disabled?: boolean
}

export function RootScopeField(props: Props) {
    const t = useTranslations('Settings')
    const {
        id,
        roots,
        projects,
        mode,
        selectedRootIds,
        selectedProjectIds,
        onModeChange,
        onSelectedRootsChange,
        onSelectedProjectsChange,
        disabled
    } = props
    function toggleRoot(rootId: string) {
        if (selectedRootIds.includes(rootId)) {
            onSelectedRootsChange(selectedRootIds.filter(function notId(x) { return x !== rootId }))
            return
        }
        onSelectedRootsChange([...selectedRootIds, rootId])
    }
    function toggleProject(projectId: string) {
        if (selectedProjectIds.includes(projectId)) {
            onSelectedProjectsChange(selectedProjectIds.filter(function notId(x) { return x !== projectId }))
            return
        }
        onSelectedProjectsChange([...selectedProjectIds, projectId])
    }
    const nothingSelected = selectedRootIds.length === 0 && selectedProjectIds.length === 0
    const showSelectionError = mode === 'selected' && nothingSelected
    const canSelect = roots.length > 0 || projects.length > 0
    return (
        <div className="flex flex-col gap-2">
            <Label>{t('scope.label')}</Label>
            <div className="flex flex-col gap-2 rounded-md border bg-card p-3">
                <label className="flex items-start gap-2 text-sm">
                    <input
                        type="radio"
                        name={'scope-mode-' + id}
                        checked={mode === 'all'}
                        onChange={function onChange() { onModeChange('all') }}
                        disabled={disabled}
                        className="mt-0.5 h-4 w-4"
                    />
                    <span>
                        <span className="font-medium">{t('scope.allRoots')}</span>
                        <span className="block text-xs text-muted-foreground">
                            {t('scope.allRootsHelp')}
                        </span>
                    </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                    <input
                        type="radio"
                        name={'scope-mode-' + id}
                        checked={mode === 'selected'}
                        onChange={function onChange() { onModeChange('selected') }}
                        disabled={disabled || !canSelect}
                        className="mt-0.5 h-4 w-4"
                    />
                    <span>
                        <span className="font-medium">{t('scope.selectedRoots')}</span>
                        <span className="block text-xs text-muted-foreground">
                            {t('scope.selectedRootsHelp')}
                        </span>
                    </span>
                </label>
                {mode === 'selected' ? (
                    <div className="ml-6 flex flex-col gap-3 border-l pl-3">
                        {!canSelect ? (
                            <p className="text-xs text-muted-foreground">
                                {t('scope.noRoots')}
                            </p>
                        ) : null}
                        {roots.length > 0 ? (
                            <div className="flex flex-col gap-1">
                                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    {t('scope.rootsHeading')}
                                </span>
                                {roots.map(function row(r) {
                                    const checked = selectedRootIds.includes(r.id)
                                    return (
                                        <label key={r.id} className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={function onChange() { toggleRoot(r.id) }}
                                                disabled={disabled}
                                                className="h-4 w-4"
                                            />
                                            <span className="flex flex-col">
                                                <span>{r.label || r.path.split('/').slice(-1)[0] || r.path}</span>
                                                <span className="font-mono text-xs text-muted-foreground">{r.path}</span>
                                            </span>
                                        </label>
                                    )
                                })}
                            </div>
                        ) : null}
                        {projects.length > 0 ? (
                            <div className="flex flex-col gap-1">
                                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    {t('scope.projectsHeading')}
                                </span>
                                {projects.map(function row(p) {
                                    const checked = selectedProjectIds.includes(p.id)
                                    return (
                                        <label key={p.id} className="flex items-center gap-2 text-sm">
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={function onChange() { toggleProject(p.id) }}
                                                disabled={disabled}
                                                className="h-4 w-4"
                                            />
                                            <span className="flex flex-col">
                                                <span>{p.alias || p.name}</span>
                                                <span className="font-mono text-xs text-muted-foreground">{p.relPath}</span>
                                            </span>
                                        </label>
                                    )
                                })}
                            </div>
                        ) : null}
                    </div>
                ) : null}
                {showSelectionError ? (
                    <p className="text-xs text-destructive">
                        {t.rich('scope.selectionError', {
                            all: function all(chunks) { return <span className="font-medium">{chunks}</span> }
                        })}
                    </p>
                ) : null}
            </div>
        </div>
    )
}

// Helper kept here so call sites don't repeat the empty-array sentinel logic. "selected" iff either
// the root list or the project list is non-empty.
export function modeFromScope(rootIds: string[], projectIds: string[]): RootScopeMode {
    return rootIds.length === 0 && projectIds.length === 0 ? 'all' : 'selected'
}
