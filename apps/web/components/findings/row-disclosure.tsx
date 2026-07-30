'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'

// The expand/collapse control for the three grouped findings tables.
//
// A real <button> in the leading cell, NOT role="button" on the <TableRow> the way
// findings/scan-history.tsx does it. That difference is deliberate and load-bearing: a ScanHistory row
// contains nothing interactive, but these rows carry their own controls — a MuteLibraryButton in
// libraries-table, an advisory <Link> in library-by-advisory-table, a project <Link> in
// library-by-project-table. ARIA gives the button role Children Presentational: true, so putting that
// role on the row prunes those nested controls out of the accessibility tree entirely, and an
// aria-label on the row replaces every cell's text with one string. A button inside the cell keeps the
// row/cell relationship intact, gives each row a DISTINCT accessible name (which a row-level role
// cannot), and gets Enter/Space handling from the platform rather than a hand-written onKeyDown.
//
// Before this existed the only click target was a bare <TableCell onClick>, so the rows could not be
// expanded from a keyboard at all and exposed no state — WCAG 2.1.1 and 4.1.2 failures both.
type Props = {
    open: boolean
    label: string
    onToggle: () => void
}

export function RowDisclosure({ open, label, onToggle }: Props) {
    return (
        <button
            type="button"
            aria-expanded={open}
            aria-label={label}
            onClick={function flip(e) {
                // The mobile card variants keep an onClick on their wrapper <div>, so without this the
                // click toggles twice and the card visibly never opens.
                e.stopPropagation()
                onToggle()
            }}
            // Negative margin reclaiming the cell's own padding. Without it the hit box collapses from
            // the full padded cell to the 16px icon — a WCAG 2.5.8 regression, and in practice a "the
            // row stopped opening" bug report.
            className="-m-3 flex items-center justify-center p-3 text-muted-foreground"
        >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
    )
}
