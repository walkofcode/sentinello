'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/cn'

export type DropdownOption = {
    value: string
    label: string
    // Optional rich rendering for the menu row (e.g. a source Badge); the trigger always uses `label`.
    node?: ReactNode
    disabled?: boolean
}

type BaseProps = {
    ariaLabel: string
    options: DropdownOption[]
    id?: string
    disabled?: boolean
    // Show a type-to-filter search box at the top of the panel (for long lists like timezones).
    searchable?: boolean
    placeholder?: string
    // Wrapper class — pass 'w-full' for form-width controls; omit for content-width filter controls.
    className?: string
    triggerClassName?: string
}

type SingleProps = BaseProps & {
    multiple?: false
    value: string
    onChange: (value: string) => void
}

type MultiProps = BaseProps & {
    multiple: true
    values: string[]
    onChange: (values: string[]) => void
    // Trigger label shown when nothing (= everything) is selected.
    allLabel: string
}

type Props = SingleProps | MultiProps

const TRIGGER_BASE =
    'inline-flex h-9 w-full min-w-[8rem] items-center justify-between gap-2 rounded-md border bg-transparent px-3 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50'

// Unified custom dropdown used everywhere a native <select> used to live. Single-select by default;
// pass `multiple` for a checkbox-style multi-select (e.g. the source filter). Trigger + popover chrome
// are shared so every dropdown in the app reads identically. Closes on outside-click / Escape; supports
// arrow-key navigation and an optional search box for long option lists.
export function Dropdown(props: Props) {
    const t = useTranslations('Common')
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [highlight, setHighlight] = useState(0)
    const wrapperRef = useRef<HTMLDivElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const searchRef = useRef<HTMLInputElement>(null)

    const filtered = useMemo(function applyQuery() {
        const q = query.trim().toLowerCase()
        if (!q) return props.options
        return props.options.filter(function match(o) { return o.label.toLowerCase().includes(q) })
    }, [props.options, query])

    useEffect(function focusOnOpen() {
        if (!open) return
        if (props.searchable && searchRef.current) searchRef.current.focus()
        else if (panelRef.current) panelRef.current.focus()
    }, [open, props.searchable])

    useEffect(function resetHighlight() {
        setHighlight(0)
    }, [query])

    useEffect(function bindOutsideClick() {
        if (!open) return
        function onMouseDown(e: MouseEvent) {
            const target = e.target as Node | null
            if (wrapperRef.current && target && !wrapperRef.current.contains(target)) setOpen(false)
        }
        document.addEventListener('mousedown', onMouseDown)
        return function cleanup() { document.removeEventListener('mousedown', onMouseDown) }
    }, [open])

    // For multi-select, an empty selection means "all" — so every row reads as checked and toggling one
    // narrows from the full set rather than inverting. Single-select compares against the chosen value.
    const effective = props.multiple && props.values.length === 0
        ? props.options.map(function val(o) { return o.value })
        : (props.multiple ? props.values : [])
    function isSelected(o: DropdownOption): boolean {
        return props.multiple ? effective.includes(o.value) : props.value === o.value
    }
    function choose(o: DropdownOption) {
        if (o.disabled) return
        if (props.multiple) {
            const next = props.options
                .filter(function keep(opt) {
                    const on = effective.includes(opt.value)
                    return opt.value === o.value ? !on : on
                })
                .map(function val(opt) { return opt.value })
            props.onChange(next)
        } else {
            props.onChange(o.value)
            setOpen(false)
        }
    }
    function open_() {
        if (props.disabled) return
        setQuery('')
        setOpen(true)
    }
    function toggle() {
        if (open) setOpen(false)
        else open_()
    }
    function onTriggerKeyDown(e: React.KeyboardEvent) {
        if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            open_()
        }
    }
    function onPanelKeyDown(e: React.KeyboardEvent) {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlight(function down(h) { return Math.min(h + 1, filtered.length - 1) })
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlight(function up(h) { return Math.max(h - 1, 0) })
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const o = filtered[highlight]
            if (o) choose(o)
        } else if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
        }
    }

    let triggerLabel: string
    if (props.multiple) {
        const allSelected = props.values.length === 0 || props.values.length === props.options.length
        triggerLabel = allSelected
            ? props.allLabel
            : props.options
                .filter(function on(o) { return props.values.includes(o.value) })
                .map(function lbl(o) { return o.label })
                .join(', ')
    } else {
        const sel = props.options.find(function eq(o) { return o.value === props.value })
        triggerLabel = sel ? sel.label : (props.placeholder || '')
    }

    return (
        <div ref={wrapperRef} className={cn('relative inline-block', props.className)}>
            <button
                type="button"
                id={props.id}
                disabled={props.disabled}
                onClick={toggle}
                onKeyDown={onTriggerKeyDown}
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={props.ariaLabel}
                className={cn(TRIGGER_BASE, props.triggerClassName)}
            >
                <span className="truncate">{triggerLabel}</span>
                <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
            </button>
            {open && (
                <div
                    ref={panelRef}
                    role="listbox"
                    tabIndex={-1}
                    onKeyDown={onPanelKeyDown}
                    className="absolute left-0 top-full z-40 mt-1 min-w-full max-w-[20rem] rounded-md border bg-card shadow-md focus:outline-none"
                >
                    {props.searchable ? (
                        <div className="border-b p-1">
                            <input
                                ref={searchRef}
                                type="text"
                                value={query}
                                onChange={function onSearch(e) { setQuery(e.target.value) }}
                                placeholder={t('search')}
                                aria-label={t('search')}
                                className="h-8 w-full rounded-sm bg-transparent px-2 text-sm focus:outline-none"
                            />
                        </div>
                    ) : null}
                    <div className="max-h-64 overflow-auto p-1">
                        {filtered.length === 0 ? (
                            <div className="px-2 py-1.5 text-sm text-muted-foreground">{t('noMatches')}</div>
                        ) : (
                            filtered.map(function row(o, i) {
                                const active = isSelected(o)
                                return (
                                    <button
                                        key={o.value}
                                        type="button"
                                        role="option"
                                        aria-selected={active}
                                        disabled={o.disabled}
                                        onMouseEnter={function hover() { setHighlight(i) }}
                                        onClick={function pick() { choose(o) }}
                                        className={cn(
                                            'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
                                            i === highlight && 'bg-accent text-accent-foreground',
                                            o.disabled && 'opacity-50'
                                        )}
                                    >
                                        <Check className={cn('h-4 w-4 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
                                        <span className="min-w-0 truncate">{o.node || o.label}</span>
                                    </button>
                                )
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
