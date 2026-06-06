'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import type { DepTypeFilter, Severity } from '@sentinello/core'
import { updateFilterDefaultsAction, type FilterDefaultsInput } from '@/lib/actions/settings'
import { Dropdown } from '@/components/ui/dropdown'

type MinSeverity = '' | Severity

const DEP_TYPE_VALUES: DepTypeFilter[] = ['prod', 'all', 'dev']

const MIN_SEVERITY_VALUES: MinSeverity[] = ['', 'critical', 'high', 'moderate', 'low']

const SORT_VALUES: string[] = ['severity', 'name']

type Props = {
    initial: FilterDefaultsInput
}

export function FilterDefaultsForm({ initial }: Props) {
    const t = useTranslations('Settings')
    const tc = useTranslations('Common')
    const [depType, setDepType] = useState<DepTypeFilter>(initial.depType)
    const [minSeverity, setMinSeverity] = useState<MinSeverity>(initial.minSeverity)
    const [sort, setSort] = useState<string>(initial.sort)
    const [pending, startTransition] = useTransition()
    const [savedAt, setSavedAt] = useState<number | null>(null)

    function commit(next: FilterDefaultsInput) {
        startTransition(async function persist() {
            await updateFilterDefaultsAction(next)
            setSavedAt(Date.now())
        })
    }
    function chooseDepType(value: DepTypeFilter) {
        setDepType(value)
        commit({ depType: value, minSeverity, sort })
    }
    function changeMinSeverity(value: MinSeverity) {
        setMinSeverity(value)
        commit({ depType, minSeverity: value, sort })
    }
    function changeSort(value: string) {
        setSort(value)
        commit({ depType, minSeverity, sort: value })
    }

    return (
        <div className="space-y-8 rounded-(--radius-card) border bg-card p-6">
            <div className="space-y-3">
                <h3 className="text-sm font-semibold">{t('defaults.depViewTitle')}</h3>
                <p className="text-xs text-muted-foreground">
                    {t('defaults.depViewHelp')}
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                    {DEP_TYPE_VALUES.map(function pick(value) {
                        const isSelected = depType === value
                        return (
                            <button
                                key={value}
                                type="button"
                                onClick={function choose() { chooseDepType(value) }}
                                className={
                                    'rounded-md border px-3 py-3 text-left text-sm transition-colors ' +
                                    (isSelected
                                        ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                        : 'border-border hover:bg-accent')
                                }
                            >
                                <div className="font-medium">{t('defaults.depType.' + value + '.label')}</div>
                                <div className="mt-1 text-xs text-muted-foreground">{t('defaults.depType.' + value + '.description')}</div>
                            </button>
                        )
                    })}
                </div>
            </div>

            <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-2">
                    <label htmlFor="defaults-min-sev" className="block text-sm font-medium">{t('defaults.minSeverityLabel')}</label>
                    <Dropdown
                        id="defaults-min-sev"
                        className="w-full"
                        ariaLabel={t('defaults.minSeverityLabel')}
                        value={minSeverity}
                        onChange={function onChange(v) { changeMinSeverity(v as MinSeverity) }}
                        options={MIN_SEVERITY_VALUES.map(function opt(value) {
                            return { value, label: t('defaults.minSeverity.' + (value || 'any')) }
                        })}
                    />
                    <p className="text-xs text-muted-foreground">
                        {t('defaults.minSeverityHelp')}
                    </p>
                </div>

                <div className="space-y-2">
                    <label htmlFor="defaults-sort" className="block text-sm font-medium">{t('defaults.sortLabel')}</label>
                    <Dropdown
                        id="defaults-sort"
                        className="w-full"
                        ariaLabel={t('defaults.sortLabel')}
                        value={sort}
                        onChange={changeSort}
                        options={SORT_VALUES.map(function opt(value) {
                            return { value, label: t('defaults.sort.' + value) }
                        })}
                    />
                    <p className="text-xs text-muted-foreground">
                        {t('defaults.sortHelp')}
                    </p>
                </div>
            </div>

            <div className="text-xs text-muted-foreground" aria-live="polite">
                {pending ? tc('saving') : (savedAt ? t('defaults.saved') : t('defaults.savedHint'))}
            </div>
        </div>
    )
}
