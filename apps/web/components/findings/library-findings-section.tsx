'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { LibraryProjectUsage } from '@sentinello/db'
import type { Mute } from '@sentinello/core'
import { Tabs } from '@/components/ui/tabs'
import { LibraryByAdvisoryTable } from './library-by-advisory-table'
import { LibraryByProjectTable } from './library-by-project-table'

type View = 'advisory' | 'project'

type Props = {
    packageName: string
    usages: LibraryProjectUsage[]
    activeMutes: Mute[]
    now: number
}

export function LibraryFindingsSection({ packageName, usages, activeMutes, now }: Props) {
    const t = useTranslations('Findings')
    const [view, setView] = useState<View>('advisory')
    const advisoryCount = useMemo(function count() {
        return new Set(usages.map(function pickAdv(u) { return u.advisoryId })).size
    }, [usages])
    const projectCount = useMemo(function count() {
        return new Set(usages.map(function pickProj(u) { return u.projectId })).size
    }, [usages])
    return (
        <div className="space-y-3">
            <Tabs
                ariaLabel={t('libraryGroupingAriaLabel')}
                value={view}
                onChange={function change(v) { setView(v as View) }}
                tabs={[
                    { value: 'advisory', label: t('byAdvisory'), count: advisoryCount },
                    { value: 'project', label: t('byProject'), count: projectCount }
                ]}
            />
            {(view === 'advisory' && (
                <LibraryByAdvisoryTable packageName={packageName} usages={usages} activeMutes={activeMutes} now={now} />
            )) || (
                <LibraryByProjectTable packageName={packageName} usages={usages} activeMutes={activeMutes} now={now} />
            )}
        </div>
    )
}
