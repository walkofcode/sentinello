'use client'

import { useState } from 'react'
import { CopyBlock } from './copy-block'
import { cn } from '@/lib/cn'

type Tab = {
    id: string
    label: string
    code: string
}

type Props = {
    tabs: Tab[]
}

export function CommandTabs({ tabs }: Props) {
    const [active, setActive] = useState<string>(tabs[0].id)
    const current = tabs.find(function match(tab) { return tab.id === active }) || tabs[0]
    return (
        <div>
            <div role="tablist" className="flex gap-1">
                {tabs.map(function tabButton(tab) {
                    const isActive = tab.id === active
                    return (
                        <button
                            key={tab.id}
                            role="tab"
                            aria-selected={isActive}
                            onClick={function select() { setActive(tab.id) }}
                            className={cn(
                                'rounded-t-md border border-b-0 px-4 py-2 text-sm font-medium transition-colors',
                                isActive
                                    ? 'bg-card text-foreground'
                                    : 'border-transparent text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {tab.label}
                        </button>
                    )
                })}
            </div>
            <CopyBlock code={current.code} className="rounded-tl-none" />
        </div>
    )
}
