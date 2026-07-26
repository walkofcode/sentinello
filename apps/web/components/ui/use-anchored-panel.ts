'use client'

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

type Align = 'left' | 'right'

type Options = {
    // Max panel width, used to keep a left-aligned panel inside the viewport.
    width: number
    // How much room the panel needs below the trigger before it flips above instead.
    flipThreshold: number
    align?: Align
    // Gap between trigger and panel.
    offset?: number
    // Mirrors a `min-w-full` panel: the panel is at least as wide as its trigger.
    matchTriggerWidth?: boolean
}

type AnchoredPanel<T extends HTMLElement> = {
    open: boolean
    setOpen: (next: boolean) => void
    toggle: () => void
    close: () => void
    triggerRef: RefObject<T | null>
    panelRef: RefObject<HTMLDivElement | null>
    // Null while closed; spread onto the portalled panel when open.
    style: CSSProperties | null
}

const VIEWPORT_MARGIN = 8

// Open/close state plus fixed-position coordinates for a panel that must be rendered in a portal.
// Every scroll container in the app clips absolutely-positioned popups: `overflow-x-auto` on the
// table wrapper (components/ui/table.tsx) computes overflow-y to `auto` as well, and dialog bodies
// scroll vertically outright. A panel anchored with `absolute top-full` therefore gets cut off at
// the container edge, so consumers render through `createPortal(..., document.body)` and position
// with these coordinates, flipping above the trigger when there is no room below.
export function useAnchoredPanel<T extends HTMLElement>(options: Options): AnchoredPanel<T> {
    const { width, flipThreshold, align = 'left', offset = 4, matchTriggerWidth = false } = options
    const [open, setOpenState] = useState<boolean>(false)
    const [style, setStyle] = useState<CSSProperties | null>(null)
    const triggerRef = useRef<T | null>(null)
    const panelRef = useRef<HTMLDivElement | null>(null)

    function place() {
        const trigger = triggerRef.current
        if (!trigger) return
        const rect = trigger.getBoundingClientRect()
        const next: CSSProperties = { position: 'fixed', top: rect.bottom + offset }
        if (window.innerHeight - rect.bottom < flipThreshold) {
            next.top = rect.top - offset
            next.transform = 'translateY(-100%)'
        }
        if (align === 'right') {
            // Anchoring by `right` keeps the panel's right edge on the trigger's without having to
            // know how wide the panel renders.
            next.right = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right)
        } else {
            next.left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN))
        }
        if (matchTriggerWidth) next.minWidth = rect.width
        setStyle(next)
    }

    function setOpen(next: boolean) {
        if (next) place()
        setOpenState(next)
    }
    function toggle() {
        setOpen(!open)
    }
    function close() {
        setOpenState(false)
    }

    useEffect(function bindWhileOpen() {
        if (!open) return
        function onPointerDown(e: MouseEvent) {
            const target = e.target as Node | null
            if (!target) return
            if (triggerRef.current && triggerRef.current.contains(target)) return
            if (panelRef.current && panelRef.current.contains(target)) return
            setOpenState(false)
        }
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') setOpenState(false)
        }
        function onReflow(e: Event) {
            // Capture-phase scroll also fires for element scrolls, so a panel with its own scrolling
            // option list would otherwise close itself the moment that list is scrolled. The target
            // is not always a Node (window for resize, and for scroll events dispatched at window),
            // hence the instanceof guard rather than a cast.
            const target = e.target
            if (e.type === 'scroll' && target instanceof Node && panelRef.current && panelRef.current.contains(target)) {
                return
            }
            setOpenState(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKey)
        window.addEventListener('scroll', onReflow, true)
        window.addEventListener('resize', onReflow)
        return function cleanup() {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKey)
            window.removeEventListener('scroll', onReflow, true)
            window.removeEventListener('resize', onReflow)
        }
    }, [open])

    let panelStyle: CSSProperties | null = null
    if (open) panelStyle = style
    return { open, setOpen, toggle, close, triggerRef, panelRef, style: panelStyle }
}
