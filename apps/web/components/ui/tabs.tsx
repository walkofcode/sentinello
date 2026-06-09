'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@/lib/cn'

export type TabItem = {
    value: string
    label: string
    count?: number | null
}

type Props = {
    value: string
    onChange: (value: string) => void
    tabs: TabItem[]
    className?: string
    ariaLabel?: string
}

export function Tabs({ value, onChange, tabs, className, ariaLabel }: Props) {
    const tc = useTranslations('Common')
    return (
        <div
            role="tablist"
            aria-label={ariaLabel || tc('viewSelector')}
            className={cn(
                'inline-flex items-center gap-1 rounded-md border bg-card p-1',
                className
            )}
        >
            {tabs.map(function renderTab(tab) {
                const active = tab.value === value
                return (
                    <button
                        key={tab.value}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={function pick() { onChange(tab.value) }}
                        className={cn(
                            'inline-flex h-8 items-center gap-2 rounded-sm px-3 text-xs font-medium transition-colors',
                            active
                                ? 'bg-primary text-primary-foreground'
                                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                        )}
                    >
                        <span>{tab.label}</span>
                        {typeof tab.count === 'number' ? (
                            <span
                                className={cn(
                                    'rounded-sm px-1.5 py-0.5 text-[0.625rem] font-mono',
                                    active ? 'bg-primary-foreground/15' : 'bg-muted'
                                )}
                            >
                                {tab.count}
                            </span>
                        ) : null}
                    </button>
                )
            })}
        </div>
    )
}
