import { describe, expect, it } from 'vitest'
import { cn } from './cn'

// cn is clsx (conditional joining) composed with tailwind-merge (last-wins conflict resolution).
// The composition order is the whole point and it is invisible from the call site: swapping it, or
// dropping twMerge for a bare join, still produces a plausible-looking className. The difference
// only shows at render time, as an override that silently does not apply because both classes are
// present and Tailwind's own output order decides the winner instead of the caller.

describe('conditional joining', function () {
    it('joins plain strings', function () {
        expect(cn('rounded', 'border')).toBe('rounded border')
    })

    it('drops falsy values instead of stringifying them', function () {
        expect(cn('rounded', false, null, undefined, 0, '', 'border')).toBe('rounded border')
    })

    it('accepts the conditional-object form', function () {
        expect(cn('rounded', { border: true, 'opacity-50': false })).toBe('rounded border')
    })

    it('flattens nested arrays', function () {
        expect(cn(['rounded', ['border', 'p-2']])).toBe('rounded border p-2')
    })

    it('returns an empty string when everything is falsy', function () {
        expect(cn(false, null, undefined)).toBe('')
    })
})

describe('conflict resolution', function () {
    // The reason twMerge is here at all: a component's own class has to be able to beat its default.
    // A bare join would emit "p-2 p-4" and let Tailwind's stylesheet order pick, which means the same
    // call site renders differently depending on which utility happens to be generated later.
    it('keeps the last of two conflicting utilities', function () {
        expect(cn('p-2', 'p-4')).toBe('p-4')
    })

    it('resolves conflicts across the whole argument list, not just adjacent pairs', function () {
        expect(cn('text-sm', 'font-bold', 'text-lg')).toBe('font-bold text-lg')
    })

    it('treats different axes of the same property as independent', function () {
        expect(cn('px-2', 'py-4')).toBe('px-2 py-4')
    })

    it('scopes conflict resolution to matching variants', function () {
        // hover:p-4 does not override the unprefixed p-2 — they apply in different states.
        expect(cn('p-2', 'hover:p-4')).toBe('p-2 hover:p-4')
        expect(cn('hover:p-2', 'hover:p-4')).toBe('hover:p-4')
    })

    // The two halves have to run in this order. clsx first flattens conditionals into a single
    // string, then twMerge resolves across the whole of it; running twMerge per-argument instead
    // would never see the pair that conflicts.
    it('resolves conflicts introduced by a conditional', function () {
        expect(cn('p-2', { 'p-4': true })).toBe('p-4')
        expect(cn('p-2', { 'p-4': false })).toBe('p-2')
    })

    it('resolves a conflict spanning an array boundary', function () {
        expect(cn(['bg-white'], ['bg-black'])).toBe('bg-black')
    })
})
