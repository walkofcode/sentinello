// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, describe, expect, it } from 'vitest'
import { Dialog } from './dialog'

// The regression this file exists for: typing inside a dialog used to lose focus after ONE character,
// which made the mute dialog's Reason field — required, free-text, and the only thing that makes a mute
// auditable later — impossible to fill in.
//
// The cause was not in the field. Dialog restores focus to whatever opened it when its effect tears
// down, and the effect depended on `onClose`. Every call site declares that inline, so it is a new
// function identity on every render — meaning each keystroke re-ran the effect, and the cleanup threw
// focus back to the trigger button. The fix reads onClose through a ref and depends on [open] alone.
//
// So the assertion that matters is that focus SURVIVES a re-render caused by state changing while the
// dialog is open, with an inline onClose written exactly the way the real call sites write it. A test
// that hoisted onClose into a useCallback would pass against the bug.
//
// Deliberately no @testing-library/user-event or jest-dom: fireEvent plus plain assertions reach this
// behaviour, and adding a dev dependency here would force a full pnpm re-resolution against the
// release-age quarantine for no gain.

const MESSAGES = { Common: { close: 'Close' } }

// Explicit, because @testing-library/react only auto-cleans when vitest runs with `globals: true`.
// Without this each render stacks onto the same document and the by-role queries go ambiguous.
afterEach(cleanup)

function Harness() {
    const [open, setOpen] = useState(false)
    const [reason, setReason] = useState('')
    return (
        <NextIntlClientProvider locale="en" messages={MESSAGES}>
            <button type="button" onClick={function show() { setOpen(true) }}>
                Mute finding
            </button>
            <Dialog
                open={open}
                onClose={function close() { setOpen(false) }}
                title="Mute finding — lodash"
                description="Silences this specific advisory for this project."
            >
                <label htmlFor="reason">Reason</label>
                <textarea
                    id="reason"
                    value={reason}
                    onChange={function onChange(e) { setReason(e.target.value) }}
                />
            </Dialog>
        </NextIntlClientProvider>
    )
}

// The opener can legitimately disappear while the dialog is open: muting a finding swaps the row's
// "Mute" trigger for an "Unmute" one, so by the time the dialog closes the button that opened it is
// gone from the tree. Restoring focus to it must be skipped rather than thrown on.
function VanishingOpenerHarness() {
    const [open, setOpen] = useState(false)
    const [openerPresent, setOpenerPresent] = useState(true)
    return (
        <NextIntlClientProvider locale="en" messages={MESSAGES}>
            {openerPresent ? (
                <button
                    type="button"
                    onClick={function show() { setOpenerPresent(false); setOpen(true) }}
                >
                    Mute finding
                </button>
            ) : null}
            <Dialog open={open} onClose={function close() { setOpen(false) }} title="Mute finding">
                <p>body</p>
            </Dialog>
        </NextIntlClientProvider>
    )
}

function openDialog(): HTMLElement {
    const opener = screen.getByRole('button', { name: 'Mute finding' })
    opener.focus()
    fireEvent.click(opener)
    return opener
}

describe('Dialog focus handling', function () {
    it('keeps focus in the field across the re-renders that typing causes', function () {
        render(<Harness />)
        openDialog()

        const field = screen.getByLabelText('Reason') as HTMLTextAreaElement
        field.focus()
        // Two changes, not one. The bug let the FIRST character land and stole focus on the re-render
        // it caused, so a single-keystroke assertion would have passed against it.
        fireEvent.change(field, { target: { value: 'accepted' } })
        expect(document.activeElement).toBe(field)
        fireEvent.change(field, { target: { value: 'accepted risk' } })

        expect(field.value).toBe('accepted risk')
        expect(document.activeElement).toBe(field)
    })

    it('restores focus to the opener when it actually closes', function () {
        render(<Harness />)
        const opener = openDialog()
        expect(screen.getByRole('dialog')).toBeTruthy()

        fireEvent.keyDown(document, { key: 'Escape' })

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(document.activeElement).toBe(opener)
    })

    // The click that must NOT close it. The panel stops propagation so a click landing on the form
    // inside never reaches the backdrop handler — without that, selecting text in the Reason field or
    // clicking a label would dismiss the dialog and discard what had been typed.
    it('stays open when the click lands inside the panel', function () {
        render(<Harness />)
        openDialog()

        fireEvent.click(screen.getByRole('dialog'))

        expect(screen.queryByRole('dialog')).not.toBeNull()
    })

    it('closes on a backdrop click', function () {
        render(<Harness />)
        const opener = openDialog()
        const backdrop = screen.getByRole('dialog').parentElement as HTMLElement

        fireEvent.click(backdrop)

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(document.activeElement).toBe(opener)
    })

    it('closes on the close button', function () {
        render(<Harness />)
        openDialog()

        fireEvent.click(screen.getByRole('button', { name: 'Close' }))

        expect(screen.queryByRole('dialog')).toBeNull()
    })

    it('ignores keys other than Escape', function () {
        render(<Harness />)
        openDialog()

        fireEvent.keyDown(document, { key: 'a' })

        expect(screen.queryByRole('dialog')).not.toBeNull()
    })

    // focusin can fire with a target that is not an HTMLElement — the document itself, or an SVG node.
    // Recording one as "the opener" would later call .focus() on something that may not have it.
    it('ignores a focusin whose target is not an element', function () {
        render(<Harness />)
        const opener = openDialog()

        document.dispatchEvent(new FocusEvent('focusin'))
        fireEvent.keyDown(document, { key: 'Escape' })

        expect(document.activeElement).toBe(opener)
    })

    it('skips the focus restore when the opener is gone from the tree', function () {
        render(<VanishingOpenerHarness />)
        const opener = screen.getByRole('button', { name: 'Mute finding' })
        opener.focus()
        fireEvent.click(opener)
        expect(screen.getByRole('dialog')).toBeTruthy()

        fireEvent.keyDown(document, { key: 'Escape' })

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(document.contains(opener)).toBe(false)
        expect(document.activeElement).toBe(document.body)
    })

    // Rendered in place, a dialog opened from a table row sits inside that row's cell and inherits its
    // styling straight through the fixed positioning — `<TableCell className="text-right">` right-aligned
    // every heading and label in the mute-finding dialog, while the same dialog opened from the page
    // header looked correct. Escaping to document.body is the fix, so pin where it mounts.
    it('mounts into document.body rather than beside its trigger', function () {
        const { container } = render(
            <div className="text-right">
                <Harness />
            </div>
        )
        openDialog()

        const dialog = screen.getByRole('dialog')
        expect(container.contains(dialog)).toBe(false)
        expect(document.body.contains(dialog)).toBe(true)
    })

    it('names itself from its heading rather than a duplicated aria-label', function () {
        render(
            <NextIntlClientProvider locale="en" messages={MESSAGES}>
                <Dialog open onClose={function close() {}} title="Mute project — metenta">
                    <p>body</p>
                </Dialog>
            </NextIntlClientProvider>
        )
        expect(screen.getByRole('dialog', { name: 'Mute project — metenta' })).toBeTruthy()
    })
})
