'use client'

import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Waypoints } from 'lucide-react'
import { useAnchoredPanel } from '@/components/ui/use-anchored-panel'

type Props = {
    paths: string[][]
}

const PANEL_WIDTH = 352
const FLIP_THRESHOLD = 220

// A compact trigger next to a package name that pops the dependency path(s) on click, instead of
// spending a whole table column on a value most rows never need expanded. The panel renders in a
// fixed-position portal (see useAnchoredPanel) so it escapes the table's overflow clipping —
// otherwise the last rows' popups get cut off and force a scrollbar.
export function DepPathPopover({ paths }: Props) {
    const t = useTranslations('Findings')
    const real = paths.filter(function nonEmpty(p) { return p.length > 0 })
    const { open, toggle, triggerRef, panelRef, style } = useAnchoredPanel<HTMLButtonElement>({
        align: 'left',
        width: PANEL_WIDTH,
        flipThreshold: FLIP_THRESHOLD
    })

    if (real.length === 0) return null
    const label = t('columns.depPath')
    return (
        <span className="inline-flex align-middle">
            <button
                ref={triggerRef}
                type="button"
                aria-label={label}
                title={label}
                aria-expanded={open}
                onClick={toggle}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
                <Waypoints className="h-3.5 w-3.5" />
            </button>
            {open && style && typeof document !== 'undefined'
                ? createPortal(
                      <div
                          ref={panelRef}
                          style={{ ...style, maxWidth: PANEL_WIDTH }}
                          className="z-50 max-h-64 w-max overflow-auto rounded-md border bg-card p-2.5 text-left shadow-lg"
                      >
                          <div className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                              {label}
                          </div>
                          <div className="flex flex-col gap-1">
                              {real.map(function row(p, i) {
                                  return (
                                      // Read-only list rendered once per popover open, never reordered or mutated.
                                      // The joined path is not guaranteed unique across `real`, so it cannot be the key.
                                      // eslint-disable-next-line @eslint-react/no-array-index-key -- see above
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
