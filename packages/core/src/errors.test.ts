import { describe, expect, it } from 'vitest'
import { asError, errText } from './errors'

// These two exist to hold the arms that are unreachable everywhere they are USED. Every call site
// catches from a collaborator that throws Error and nothing else, so the non-Error side of each is
// dead there and live only here — which is the whole reason both moved out of their call sites.

describe('errText', function () {
    it('uses an Error message', function () {
        expect(errText(new Error('connect ECONNREFUSED'))).toBe('connect ECONNREFUSED')
    })

    // An Error with a blank message would otherwise log as an empty string, which reads to an operator
    // as "no detail was captured" rather than "something threw".
    it('falls back to the Error name when the message is empty', function () {
        expect(errText(new Error(''))).toBe('Error')
        expect(errText(new TypeError(''))).toBe('TypeError')
    })

    it('stringifies a non-Error', function () {
        expect(errText('just a string')).toBe('just a string')
        expect(errText(404)).toBe('404')
        expect(errText(null)).toBe('null')
        expect(errText(undefined)).toBe('undefined')
    })
})

describe('asError', function () {
    // Identity, not reconstruction: rebuilding from the message would drop the stack and the cause
    // chain, and both call sites re-throw or store what comes back.
    it('returns the same Error instance', function () {
        const cause = new Error('root cause')
        const err = new Error('outer', { cause })
        const result = asError(err)
        expect(result).toBe(err)
        expect(result.cause).toBe(cause)
        expect(result.stack).toBe(err.stack)
    })

    it('wraps a non-Error', function () {
        expect(asError('boom')).toBeInstanceOf(Error)
        expect(asError('boom').message).toBe('boom')
        expect(asError(null).message).toBe('null')
        expect(asError(7).message).toBe('7')
    })
})
