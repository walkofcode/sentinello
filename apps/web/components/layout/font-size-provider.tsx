'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type FontSize = 'small' | 'normal' | 'large' | 'extra-large'

export const FONT_SIZE_STORAGE_KEY = 'sentinello-font-size'
export const FONT_SIZE_DEFAULT: FontSize = 'normal'

type Ctx = {
    size: FontSize
    setSize: (next: FontSize) => void
}

const FontSizeContext = createContext<Ctx | null>(null)

function isFontSize(value: unknown): value is FontSize {
    return value === 'small' || value === 'normal' || value === 'large' || value === 'extra-large'
}

function readInitial(): FontSize {
    if (typeof window === 'undefined') return FONT_SIZE_DEFAULT
    try {
        const stored = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY)
        if (isFontSize(stored)) return stored
    } catch {
        // localStorage may be unavailable (private mode, sandbox); fall through to default.
    }
    return FONT_SIZE_DEFAULT
}

export function FontSizeProvider({ children }: { children: ReactNode }) {
    const [size, setSizeState] = useState<FontSize>(FONT_SIZE_DEFAULT)
    // Hydrate from localStorage on mount so React state matches the data-font-size
    // attribute the pre-hydration script already set on <html>. Server renders with
    // the default; the script applies the user's stored choice before hydration.
    useEffect(function hydrate() {
        setSizeState(readInitial())
    }, [])
    function setSize(next: FontSize) {
        setSizeState(next)
        try {
            window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, next)
        } catch {
            // Persistence is best-effort; the in-memory state still drives the UI.
        }
        document.documentElement.setAttribute('data-font-size', next)
    }
    return <FontSizeContext.Provider value={{ size, setSize }}>{children}</FontSizeContext.Provider>
}

export function useFontSize(): Ctx {
    const ctx = useContext(FontSizeContext)
    if (!ctx) throw new Error('useFontSize must be used within FontSizeProvider')
    return ctx
}
