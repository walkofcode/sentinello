'use client'

import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Scale } from 'lucide-react'
import type { Severity } from '@sentinello/core'
import { SeverityPill } from '@/components/ui/severity-pill'
import { useAnchoredPanel } from '@/components/ui/use-anchored-panel'

type Grade = {
    source: string
    advisoryId: string
    severity: Severity
}

type Props = {
    grades: Grade[]
    // The severity the finding is actually reported at — the worst of the grades below.
    reported: Severity
}

const PANEL_WIDTH = 320
const FLIP_THRESHOLD = 200

const SOURCE_LABEL: Record<string, string> = { 'npm-audit': 'npm audit', osv: 'OSV', gemnasium: 'gemnasium' }

// What each source actually said about this vulnerability, behind a click.
//
// The finding is reported at the WORST grade any source gave it — the cautious reading, and the one the
// dashboard counts and the --fail-on gate use. That is the right default and also a lossy one: a row
// showing `critical` because a single source graded it so, while the other two called it high, is a
// materially different fact from three sources agreeing. This is where that difference stays legible.
//
// Only rendered when the sources disagree. When they all say the same thing there is nothing to explain,
// and a trigger on every row would be noise — the source badges already say who reported it.
export function SourceGradesPopover({ grades, reported }: Props) {
    const t = useTranslations('Findings')
    const { open, toggle, triggerRef, panelRef, style } = useAnchoredPanel<HTMLButtonElement>({
        align: 'left',
        width: PANEL_WIDTH,
        flipThreshold: FLIP_THRESHOLD
    })

    const disagree = grades.some(function differs(g) { return g.severity !== reported })
    if (grades.length < 2 || !disagree) return null

    const label = t('grades.label')
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
                <Scale className="h-3.5 w-3.5" />
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
                          <div className="flex flex-col gap-1.5">
                              {grades.map(function row(g) {
                                  return (
                                      <div key={g.source} className="flex items-center gap-2 text-xs">
                                          <SeverityPill variant={g.severity} size="sm" />
                                          <span className="font-medium">{SOURCE_LABEL[g.source] || g.source}</span>
                                          <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                                              {g.advisoryId}
                                          </span>
                                      </div>
                                  )
                              })}
                          </div>
                          <p className="mt-2 border-t border-border/40 pt-2 text-[0.6875rem] leading-snug text-muted-foreground">
                              {t('grades.explain')}
                          </p>
                      </div>,
                      document.body
                  )
                : null}
        </span>
    )
}
