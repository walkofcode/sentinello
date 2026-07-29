// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnchoredPanel } from './use-anchored-panel'

// The hook behind every popup the portal renders through a portal rather than in place. It exists
// because every scroll container in the app clips an absolutely-positioned panel: `overflow-x-auto`
// on the table wrapper computes overflow-y to `auto` as well, and dialog bodies scroll outright. So
// consumers render into document.body and position with the fixed coordinates computed here.
//
// A per-file jsdom environment rather than a config change: every other suite runs under `node`,
// which is what they want, and the single-project config is worth keeping.
//
// IMPORTANT for anyone extending this file — jsdom has NO LAYOUT ENGINE. getBoundingClientRect()
// returns all zeros and window.innerWidth/innerHeight default to 1024x768. A test that does not stub
// the rect passes while asserting nothing: every coordinate is computed from zeros, so "it did not
// flip" and "it flipped" produce the same numbers. Every positioning test below stubs both.

const VIEWPORT_MARGIN = 8

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number }

function rect(overrides: Partial<Rect> = {}): DOMRect {
    const base = { top: 100, bottom: 130, left: 200, right: 340, width: 140, height: 30, x: 200, y: 100 }
    const merged = { ...base, ...overrides }
    return { ...merged, toJSON() { return merged } } as DOMRect
}

// Attaches a real element to the document (so contains() works for the outside-click tests) and
// gives it the rect the test needs.
function trigger(at: Partial<Rect> = {}): HTMLButtonElement {
    const el = document.createElement('button')
    document.body.appendChild(el)
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect(at))
    return el
}

function panel(): HTMLDivElement {
    const el = document.createElement('div')
    document.body.appendChild(el)
    return el
}

function viewport(width: number, height: number): void {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

// Renders the hook with a trigger already attached, since nothing positions without one.
function render(options: Parameters<typeof useAnchoredPanel>[0], triggerRect: Partial<Rect> = {}) {
    const el = trigger(triggerRect)
    const view = renderHook(function use() {
        return useAnchoredPanel<HTMLButtonElement>(options)
    })
    act(function attach() {
        view.result.current.triggerRef.current = el
    })
    return { ...view, trigger: el }
}

beforeEach(function setup() {
    viewport(1024, 768)
})

afterEach(function teardown() {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
})

describe('open and close state', function () {
    it('starts closed with no style to spread', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        expect(result.current.open).toBe(false)
        expect(result.current.style).toBeNull()
    })

    it('opens through setOpen', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        expect(result.current.open).toBe(true)
    })

    it('toggles from both states', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function first() {
            result.current.toggle()
        })
        expect(result.current.open).toBe(true)
        act(function second() {
            result.current.toggle()
        })
        expect(result.current.open).toBe(false)
    })

    it('closes through close()', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        act(function close() {
            result.current.close()
        })
        expect(result.current.open).toBe(false)
    })

    // style reads null while closed even though the last computed position is still held in state.
    // Consumers spread it onto a portalled panel; leaking a stale position would flash the panel at
    // its previous coordinates on the next open.
    it('hides the style again once closed', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        expect(result.current.style).not.toBeNull()
        act(function close() {
            result.current.close()
        })
        expect(result.current.style).toBeNull()
    })

    // Positioning happens on the way OPEN only. Measuring on close would read a rect that is about to
    // stop mattering, and measuring on every render would thrash on unrelated state changes.
    it('measures when opening but not when closing', function () {
        const { result, trigger: el } = render({ width: 200, flipThreshold: 200 })
        const measure = vi.mocked(el.getBoundingClientRect)

        act(function open() {
            result.current.setOpen(true)
        })
        const afterOpen = measure.mock.calls.length
        expect(afterOpen).toBeGreaterThan(0)

        act(function close() {
            result.current.setOpen(false)
        })
        expect(measure.mock.calls.length).toBe(afterOpen)
    })

    // Nothing to measure against: bail out rather than reading a rect off null.
    it('does nothing when there is no trigger attached', function () {
        const view = renderHook(function use() {
            return useAnchoredPanel<HTMLButtonElement>({ width: 200, flipThreshold: 200 })
        })
        act(function open() {
            view.result.current.setOpen(true)
        })
        expect(view.result.current.open).toBe(true)
        expect(view.result.current.style).toBeNull()
    })
})

describe('positioning below the trigger', function () {
    it('sits under the trigger with the configured offset', function () {
        const { result } = render({ width: 200, flipThreshold: 200, offset: 6 }, { top: 100, bottom: 130 })
        act(function open() {
            result.current.setOpen(true)
        })
        expect(result.current.style).toMatchObject({ position: 'fixed', top: 136 })
        expect(result.current.style?.transform).toBeUndefined()
    })

    it('defaults the offset to 4', function () {
        const { result } = render({ width: 200, flipThreshold: 200 }, { bottom: 130 })
        act(function open() {
            result.current.setOpen(true)
        })
        expect(result.current.style).toMatchObject({ top: 134 })
    })
})

describe('flipping above the trigger', function () {
    // The flip is what stops a panel opening off the bottom of the window with no way to reach its
    // contents. It is driven by the room BELOW the trigger, not by the panel's own height, because
    // the panel has not rendered yet at the moment the position is computed.
    it('flips above when there is less room below than the threshold', function () {
        const { result } = render({ width: 200, flipThreshold: 300 }, { top: 600, bottom: 630 })
        act(function open() {
            result.current.setOpen(true)
        })
        // Anchored to the trigger's TOP and pulled fully upward, so the panel's bottom edge meets it.
        expect(result.current.style).toMatchObject({ top: 596, transform: 'translateY(-100%)' })
    })

    it('stays below when there is exactly the threshold of room', function () {
        // innerHeight 768, bottom 468 -> 300 of room, threshold 300. The check is `<`, so equal room
        // stays below; a `<=` here would flip a panel that fits.
        const { result } = render({ width: 200, flipThreshold: 300 }, { top: 440, bottom: 468 })
        act(function open() {
            result.current.setOpen(true)
        })
        expect(result.current.style?.transform).toBeUndefined()
        expect(result.current.style).toMatchObject({ top: 472 })
    })

    it('flips one pixel past the threshold', function () {
        const { result } = render({ width: 200, flipThreshold: 300 }, { top: 441, bottom: 469 })
        act(function open() {
            result.current.setOpen(true)
        })
        expect(result.current.style?.transform).toBe('translateY(-100%)')
    })
})

describe('horizontal alignment', function () {
    // Left-aligned panels are clamped by computing a left coordinate, which needs the panel's width
    // up front — hence the required `width` option. Right-aligned ones anchor by `right` instead,
    // which needs no width at all because the browser resolves it from the panel's own box.
    describe('left alignment', function () {
        it('lines the panel up with the trigger when there is room', function () {
            const { result } = render({ width: 200, flipThreshold: 200 }, { left: 300 })
            act(function open() {
                result.current.setOpen(true)
            })
            expect(result.current.style).toMatchObject({ left: 300 })
            expect(result.current.style?.right).toBeUndefined()
        })

        it('is the default alignment', function () {
            const { result } = render({ width: 200, flipThreshold: 200, align: 'left' }, { left: 300 })
            act(function open() {
                result.current.setOpen(true)
            })
            const explicit = result.current.style
            expect(explicit).toMatchObject({ left: 300 })
        })

        // A trigger near the right edge would push a fixed-width panel off-screen. The clamp pulls it
        // back so its right edge lands on the viewport margin.
        it('pulls the panel back from the right edge', function () {
            viewport(1000, 768)
            const { result } = render({ width: 200, flipThreshold: 200 }, { left: 900 })
            act(function open() {
                result.current.setOpen(true)
            })
            expect(result.current.style).toMatchObject({ left: 1000 - 200 - VIEWPORT_MARGIN })
        })

        // And the outer clamp: on a viewport too narrow to fit the panel at all, the right-edge clamp
        // would compute a NEGATIVE left. The margin floor wins so the panel stays reachable.
        it('never places the panel off the left edge', function () {
            viewport(180, 768)
            const { result } = render({ width: 200, flipThreshold: 200 }, { left: 100 })
            act(function open() {
                result.current.setOpen(true)
            })
            expect(result.current.style).toMatchObject({ left: VIEWPORT_MARGIN })
        })

        // A trigger scrolled partly off the left edge has a negative left. The panel does not follow
        // it off-screen — the margin floor applies to that direction too.
        it('clamps a trigger that starts left of the margin', function () {
            const { result } = render({ width: 200, flipThreshold: 200 }, { left: -50 })
            act(function open() {
                result.current.setOpen(true)
            })
            expect(result.current.style).toMatchObject({ left: VIEWPORT_MARGIN })
        })
    })

    describe('right alignment', function () {
        it('anchors the panel by its right edge', function () {
            viewport(1000, 768)
            const { result } = render({ width: 200, flipThreshold: 200, align: 'right' }, { right: 800 })
            act(function open() {
                result.current.setOpen(true)
            })
            expect(result.current.style).toMatchObject({ right: 200 })
            expect(result.current.style?.left).toBeUndefined()
        })

        // A trigger whose right edge is at or past the viewport edge would compute right <= 0 and put
        // the panel flush against (or past) the window.
        it('keeps the panel inside the viewport margin', function () {
            viewport(1000, 768)
            const { result } = render({ width: 200, flipThreshold: 200, align: 'right' }, { right: 1000 })
            act(function open() {
                result.current.setOpen(true)
            })
            expect(result.current.style).toMatchObject({ right: VIEWPORT_MARGIN })
        })
    })

    // Mirrors a `min-w-full` panel: never narrower than the control that opened it, which is what
    // stops a select-style dropdown looking detached from its trigger.
    it('matches the trigger width when asked', function () {
        const { result } = render({ width: 200, flipThreshold: 200, matchTriggerWidth: true }, { width: 320 })
        act(function open() {
            result.current.setOpen(true)
        })
        expect(result.current.style).toMatchObject({ minWidth: 320 })
    })

    it('leaves minWidth unset by default', function () {
        const { result } = render({ width: 200, flipThreshold: 200 }, { width: 320 })
        act(function open() {
            result.current.setOpen(true)
        })
        expect(result.current.style?.minWidth).toBeUndefined()
    })
})

describe('dismissal while open', function () {
    // The listeners are bound only while open. Binding them always would mean every panel in the
    // page runs a capture-phase scroll handler on every scroll, for panels nobody has opened.
    it('binds nothing while closed', function () {
        const add = vi.spyOn(document, 'addEventListener')
        render({ width: 200, flipThreshold: 200 })
        expect(add.mock.calls.map(function first(c) { return c[0] })).not.toContain('mousedown')
    })

    it('closes on a click outside both the trigger and the panel', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        const outside = document.createElement('div')
        document.body.appendChild(outside)

        act(function click() {
            outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        })

        expect(result.current.open).toBe(false)
    })

    // Clicking the trigger must not close-then-reopen: the consumer's own onClick toggles, and a
    // dismissal here first would make the panel appear not to open at all.
    it('ignores a click on the trigger', function () {
        const { result, trigger: el } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        act(function click() {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        })
        expect(result.current.open).toBe(true)
    })

    it('ignores a click inside the panel', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        const p = panel()
        act(function open() {
            result.current.setOpen(true)
            result.current.panelRef.current = p
        })
        const inner = document.createElement('button')
        p.appendChild(inner)

        act(function click() {
            inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        })

        expect(result.current.open).toBe(true)
    })

    // A mousedown whose target is not an element at all (dispatched on document/window). The guard
    // exists so the handler does not call contains(null).
    it('ignores an event with no target node', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        act(function click() {
            const event = new MouseEvent('mousedown', { bubbles: true })
            Object.defineProperty(event, 'target', { value: null })
            document.dispatchEvent(event)
        })
        expect(result.current.open).toBe(true)
    })

    it('closes on Escape', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        act(function key() {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })
        expect(result.current.open).toBe(false)
    })

    it('ignores any other key', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        act(function key() {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        })
        expect(result.current.open).toBe(true)
    })
})

describe('dismissal on reflow', function () {
    // The panel is positioned in fixed coordinates computed once, so anything that moves the trigger
    // invalidates them. Closing is the honest response — repositioning mid-scroll would need the
    // panel to track the trigger every frame.
    it('closes when the page scrolls', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        act(function scroll() {
            window.dispatchEvent(new Event('scroll'))
        })
        expect(result.current.open).toBe(false)
    })

    // The listener is capture-phase, which means it also fires for scrolls inside ELEMENTS — so a
    // panel containing its own scrolling option list would close itself the moment that list is
    // scrolled. This is the guard against that, and it is the subtlest branch in the hook.
    it('survives a scroll inside its own panel', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        const p = panel()
        act(function open() {
            result.current.setOpen(true)
            result.current.panelRef.current = p
        })
        const list = document.createElement('ul')
        p.appendChild(list)

        act(function scroll() {
            list.dispatchEvent(new Event('scroll', { bubbles: false }))
        })

        expect(result.current.open).toBe(true)
    })

    it('still closes on a scroll in a different element', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        const p = panel()
        act(function open() {
            result.current.setOpen(true)
            result.current.panelRef.current = p
        })
        const elsewhere = document.createElement('div')
        document.body.appendChild(elsewhere)

        act(function scroll() {
            elsewhere.dispatchEvent(new Event('scroll', { bubbles: false }))
        })

        expect(result.current.open).toBe(false)
    })

    it('closes on a scroll when no panel ref is set', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        act(function scroll() {
            document.createElement('div').dispatchEvent(new Event('scroll'))
            window.dispatchEvent(new Event('scroll'))
        })
        expect(result.current.open).toBe(false)
    })

    // resize dispatches at window, whose target is NOT a Node — hence the instanceof guard rather
    // than a cast. A resize must always close, even with the panel ref set.
    it('closes on resize even though the target is not a node', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        const p = panel()
        act(function open() {
            result.current.setOpen(true)
            result.current.panelRef.current = p
        })
        act(function resize() {
            window.dispatchEvent(new Event('resize'))
        })
        expect(result.current.open).toBe(false)
    })
})

describe('listener cleanup', function () {
    // All four come off together. A leaked capture-phase scroll listener keeps firing for the life
    // of the page and holds the whole closure — including the trigger element — alive with it.
    it('removes every listener when the panel closes', function () {
        const docRemove = vi.spyOn(document, 'removeEventListener')
        const winRemove = vi.spyOn(window, 'removeEventListener')
        const { result } = render({ width: 200, flipThreshold: 200 })

        act(function open() {
            result.current.setOpen(true)
        })
        act(function close() {
            result.current.close()
        })

        expect(docRemove.mock.calls.map(function first(c) { return c[0] })).toEqual(expect.arrayContaining(['mousedown', 'keydown']))
        expect(winRemove.mock.calls.map(function first(c) { return c[0] })).toEqual(expect.arrayContaining(['scroll', 'resize']))
    })

    it('removes every listener when the component unmounts while open', function () {
        const docRemove = vi.spyOn(document, 'removeEventListener')
        const winRemove = vi.spyOn(window, 'removeEventListener')
        const { result, unmount } = render({ width: 200, flipThreshold: 200 })

        act(function open() {
            result.current.setOpen(true)
        })
        unmount()

        expect(docRemove.mock.calls.map(function first(c) { return c[0] })).toEqual(expect.arrayContaining(['mousedown', 'keydown']))
        expect(winRemove.mock.calls.map(function first(c) { return c[0] })).toEqual(expect.arrayContaining(['scroll', 'resize']))
    })

    // The scroll listener is registered capture-phase and must be REMOVED capture-phase too:
    // removeEventListener matches on the capture flag, so dropping it leaks the listener silently.
    it('removes the scroll listener with the capture flag it was added with', function () {
        const winRemove = vi.spyOn(window, 'removeEventListener')
        const { result } = render({ width: 200, flipThreshold: 200 })

        act(function open() {
            result.current.setOpen(true)
        })
        act(function close() {
            result.current.close()
        })

        const scrollRemoval = winRemove.mock.calls.find(function isScroll(c) { return c[0] === 'scroll' })
        expect(scrollRemoval?.[2]).toBe(true)
    })

    it('stops responding to events once closed', function () {
        const { result } = render({ width: 200, flipThreshold: 200 })
        act(function open() {
            result.current.setOpen(true)
        })
        act(function close() {
            result.current.close()
        })

        act(function key() {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        })

        expect(result.current.open).toBe(false)
    })
})
