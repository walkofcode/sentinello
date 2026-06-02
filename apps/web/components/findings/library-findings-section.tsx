'use client'

import { useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { LibraryProjectUsage } from '@sentinello/db'
import type { Mute } from '@sentinello/core'
import { Tabs } from '@/components/ui/tabs'
import { advisoryIdentity } from '@/lib/merge-findings'
import { LibraryByAdvisoryTable } from './library-by-advisory-table'
import { LibraryByProjectTable } from './library-by-project-table'
import { SourceFilter, orderSources, parseSourceParam } from './source-filter'

type View = 'advisory' | 'project'

type Props = {
    packageName: string
    usages: LibraryProjectUsage[]
    activeMutes: Mute[]
    now: number
}

export function LibraryFindingsSection({ packageName, usages, activeMutes, now }: Props) {
    const t = useTranslations('Findings')
    const searchParams = useSearchParams()
    const [view, setView] = useState<View>('advisory')
    // Sources present across the loaded usages (already narrowed to active sources server-side) and the
    // user's ?src= selection over them (empty = all). Both tables run off the filtered usages.
    const sources = useMemo(function present() {
        return orderSources(usages.map(function pick(u) { return u.scanner }))
    }, [usages])
    const selected = useMemo(function parse() {
        return parseSourceParam(searchParams.get('src'), sources)
    }, [searchParams, sources])
    const visibleUsages = useMemo(function filter() {
        if (selected.length === 0) return usages
        return usages.filter(function keep(u) { return selected.includes(u.scanner) })
    }, [usages, selected])
    const advisoryCount = useMemo(function count() {
        return new Set(visibleUsages.map(function pickAdv(u) { return advisoryIdentity(u.advisoryTitle, u.advisoryId) })).size
    }, [visibleUsages])
    const projectCount = useMemo(function count() {
        return new Set(visibleUsages.map(function pickProj(u) { return u.projectId })).size
    }, [visibleUsages])
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Tabs
                    ariaLabel={t('libraryGroupingAriaLabel')}
                    value={view}
                    onChange={function change(v) { setView(v as View) }}
                    tabs={[
                        { value: 'advisory', label: t('byAdvisory'), count: advisoryCount },
                        { value: 'project', label: t('byProject'), count: projectCount }
                    ]}
                />
                <SourceFilter sources={sources} selected={selected} />
            </div>
            {(view === 'advisory' && (
                <LibraryByAdvisoryTable packageName={packageName} usages={visibleUsages} activeMutes={activeMutes} now={now} />
            )) || (
                <LibraryByProjectTable packageName={packageName} usages={visibleUsages} activeMutes={activeMutes} now={now} />
            )}
        </div>
    )
}
