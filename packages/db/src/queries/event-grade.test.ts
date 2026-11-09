import { describe, expect, it } from 'vitest'
import type { GradeAnswers, Severity } from '@sentinello/core'
import { EVENT_GRADE_VERSION, nextEventGrade, type EventGrade } from './notification-events'

// The transition over the cross-product of a source's stored answer, this sighting's answer and the held grade
// (SENTINEL-178, SENTINEL-188). The case a real instance hits is named beside each expectation in
// findings-truth-replay.test.ts; this is the table underneath them.

const STORED: (Severity | null | 'absent')[] = ['absent', null, 'moderate', 'high']
const ANSWER: (Severity | null | 'absent')[] = ['absent', null, 'moderate', 'high', 'critical']
const HELD: (Severity | null)[] = [null, 'moderate', 'high']

function answers(value: Severity | null | 'absent'): GradeAnswers {
    return value === 'absent' ? {} : { osv: value }
}

describe('nextEventGrade', function () {
    for (const stored of STORED) {
        for (const answer of ANSWER) {
            for (const held of HELD) {
                const name = 'stored ' + stored + ', answer ' + answer + ', held ' + held
                it(name + ': a change is real only if a source answering both times answers differently', function () {
                    const current: EventGrade = { severity: 'high', gradeVersion: EVENT_GRADE_VERSION, policySeverity: held, gradeAnswers: answers(stored) }
                    const newSeverity: Severity = 'critical'
                    const next = nextEventGrade(current, { severity: newSeverity, answers: answers(answer) })
                    const real = stored !== 'absent' && answer !== 'absent' && stored !== answer
                    expect(next.policySeverity).toBe(real ? null : held ?? 'high')
                    expect(next.severity).toBe('critical')
                    expect(next.gradeVersion).toBe(EVENT_GRADE_VERSION)
                    // A source not in this sighting keeps its stored answer.
                    expect(next.gradeAnswers).toEqual({ ...answers(stored), ...answers(answer) })
                })
            }
        }
    }

    it('changes nothing held when the severity did not change, whatever the answers did', function () {
        const next = nextEventGrade({ severity: 'high', gradeVersion: EVENT_GRADE_VERSION, policySeverity: 'moderate', gradeAnswers: { osv: 'high', gemnasium: 'critical' } }, { severity: 'high', answers: { osv: 'low' } })
        expect(next.policySeverity).toBe('moderate')
        expect(next.gradeAnswers).toEqual({ osv: 'low', gemnasium: 'critical' })
    })

    it('starts an event behind the version over: stored answers empty, a held grade kept, a first answer a correction', function () {
        const next = nextEventGrade({ severity: 'moderate', gradeVersion: 0, policySeverity: 'low', gradeAnswers: { osv: 'critical' } }, { severity: 'high', answers: { osv: 'high' } })
        expect(next).toEqual({ severity: 'high', gradeVersion: EVENT_GRADE_VERSION, policySeverity: 'low', gradeAnswers: { osv: 'high' } })
        const unheld = nextEventGrade({ severity: 'moderate', gradeVersion: 0, policySeverity: null, gradeAnswers: null }, { severity: 'high', answers: { osv: 'high' } })
        expect(unheld.policySeverity).toBe('moderate')
    })

    it('treats an event recorded at the current version as always: severity written, nothing held, nothing stored', function () {
        const next = nextEventGrade({ severity: 'moderate', gradeVersion: EVENT_GRADE_VERSION, policySeverity: null, gradeAnswers: null }, { severity: 'critical', answers: { osv: 'critical' } })
        expect(next).toEqual({ severity: 'critical', gradeVersion: EVENT_GRADE_VERSION, policySeverity: null, gradeAnswers: null })
    })

    it('drops a hold equal to the new severity, which says nothing', function () {
        const next = nextEventGrade({ severity: 'high', gradeVersion: EVENT_GRADE_VERSION, policySeverity: 'moderate', gradeAnswers: { osv: 'high' } }, { severity: 'moderate', answers: { gemnasium: 'moderate' } })
        expect(next.policySeverity).toBeNull()
    })
})
