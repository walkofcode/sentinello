'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Waypoints } from 'lucide-react'

type Props = {
    paths: string[][]
}

type Coords = {
    left: number
    top: number
    placement: 'below' | 'above'
}

const PANEL_WIDTH = 352
const FLIP_THRESHOLD = 220

// A compact trigger next to a package name that pops the dependency path(s) on click, instead of
// spending a whole table column on a value most rows never need expanded. The panel renders in a
// fixed-position portal so it escapes the table's overflow clipping (otherwise the last rows' popups
// get cut off and force a scrollbar), and flips above the icon when there isn't room below.
export function DepPathPopover({ paths }: Props) {
    const t = useTranslations('Findings')
    const real = paths.filter(function nonEmpty(p) { return p.length > 0 })
    const [open, setOpen] = useState(false)
    const [coords, setCoords] = useState<Coords | null>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)

    function place() {
        const button = buttonRef.current
        if (!button) return
        const rect = button.getBoundingClientRect()
        const placement: 'below' | 'above' = window.innerHeight - rect.bottom < FLIP_THRESHOLD ? 'above' : 'below'
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8))
        setCoords({ left, top: placement === 'below' ? rect.bottom + 4 : rect.top - 4, placement })
    }

    function toggle() {
        if (!open) place()
        setOpen(function flip(prev) { return !prev })
    }

    useEffect(function bindWhileOpen() {
        if (!open) return
        function onPointer(e: MouseEvent) {
            const target = e.target as Node | null
            if (!target) return
            if (buttonRef.current && buttonRef.current.contains(target)) return
            if (panelRef.current && panelRef.current.contains(target)) return
            setOpen(false)
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') setOpen(false)
        }
        function onReflow() {
            setOpen(false)
        }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        window.addEventListener('scroll', onReflow, true)
        window.addEventListener('resize', onReflow)
        return function cleanup() {
            document.removeEventListener('mousedown', onPointer)
            document.removeEventListener('keydown', onKey)
            window.removeEventListener('scroll', onReflow, true)
            window.removeEventListener('resize', onReflow)
        }
    }, [open])

    if (real.length === 0) return null
    const label = t('columns.depPath')
    return (
        <span className="inline-flex align-middle">
            <button
                ref={buttonRef}
                type="button"
                aria-label={label}
                title={label}
                aria-expanded={open}
                onClick={toggle}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
                <Waypoints className="h-3.5 w-3.5" />
            </button>
            {open && coords && typeof document !== 'undefined'
                ? createPortal(
                      <div
                          ref={panelRef}
                          style={{
                              position: 'fixed',
                              left: coords.left,
                              top: coords.top,
                              maxWidth: PANEL_WIDTH,
                              transform: coords.placement === 'above' ? 'translateY(-100%)' : undefined
                          }}
                          className="z-50 max-h-64 w-max overflow-auto rounded-md border bg-card p-2.5 text-left shadow-lg"
                      >
                          <div className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                              {label}
                          </div>
                          <div className="flex flex-col gap-1">
                              {real.map(function row(p, i) {
                                  return (
                                      <div key={i} className="font-mono text-xs text-foreground/90">
                                          {p.join(' → ')}
                                      </div>
                                  )
                              })}
                          </div>
                      </div>,
                      document.body
                  )
                : null}
        </span>
    )
}
