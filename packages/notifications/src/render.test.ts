import { describe, expect, it } from 'vitest'
import type { Finding, FixCheck, NotificationEvent, Remediation } from '@sentinello/core'
import { renderBatchedFindings, renderScanFailure, renderSingleFinding } from './render'

// Notification bodies are the part of Sentinello a recipient sees without opening the portal, so the
// interesting assertions are about what is INCLUDED and what is OMITTED — a missing branch line, a
// swallowed "no fix available", or a truncated batch are all silent information loss.

const CHECK: FixCheck = { v: 1, checkedAt: Date.UTC(2026, 9, 3), registry: 'ok', packageDataAsOf: Date.UTC(2026, 9, 3), unevaluable: null, sources: [] }

function finding(overrides: Partial<Finding> = {}): Finding {
    return {
        id: 'finding-1',
        scanId: 'scan-1',
        projectId: 'project-1',
        scanner: 'npm-audit',
        source: 'npm-audit',
        ecosystem: 'npm',
        advisoryId: 'GHSA-1',
        advisoryTitle: null,
        advisoryUrl: null,
        packageName: 'lodash',
        installedVersion: '4.17.20',
        vulnerableRange: '<4.17.21',
        severity: 'high',
        fixStatus: 'none_released',
        fixAvailable: false,
        fixVersion: null,
        fixCheck: CHECK,
        remediation: null,
        corroborations: [],
        depPath: [],
        isProd: true,
        isDev: false,
        firstDetectedAt: null,
        lastSeenAt: null,
        resolvedAt: null,
        resolvedScanId: null,
        ...overrides
    }
}

function scanFailureEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
    return {
        id: 'event-1',
        eventType: 'scan_failure',
        identityKey: 'project-1|npm-audit|error|no_lockfile',
        projectId: 'project-1',
        scanner: 'npm-audit',
        ecosystem: null,
        advisoryId: null,
        packageName: null,
        severity: null,
        failureSignature: 'error:no_lockfile',
        firstScanId: 'scan-1',
        firstSeenAt: 0,
        firstNotifiedAt: null,
        lastSeenAt: 0,
        ...overrides
    }
}

function manyFindings(n: number): Finding[] {
    const out: Finding[] = []
    for (let i = 0; i < n; i++) {
        out.push(finding({ packageName: 'pkg' + i, advisoryId: 'GHSA-' + i }))
    }
    return out
}

const BASE_URL = 'https://sentinello.example'

describe('renderSingleFinding', function () {
    it('builds a title carrying severity, package and project', function () {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding(),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.title).toBe('[HIGH] lodash@4.17.20 in api')
    })

    // findings.severity is a plain TEXT column written from whatever a feed said, so the Severity type
    // is a claim rather than a guarantee. Indexing the label map directly used to hand an operator an
    // alert titled "[undefined]" — the one line they read first, saying nothing at all.
    it.each([
        ['HIGH', 'HIGH'],
        [' high ', 'HIGH'],
        ['catastrophic', 'CATASTROPHIC'],
        // Empty is the one case with nothing to echo back, so it falls to the same "unknown weighs
        // moderate" policy core applies rather than printing an empty grade.
        ['', 'MODERATE'],
        ['   ', 'MODERATE']
    ])('renders severity %j as %s rather than undefined', function (severity, expected) {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding({ severity: severity as Finding['severity'] }),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.title).toBe('[' + expected + '] lodash@4.17.20 in api')
        expect(out.markdown).not.toContain('undefined')
    })

    it('marks a first-scan finding as baseline', function () {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding(),
            isBaseline: true,
            portalBaseUrl: null
        })
        expect(out.markdown).toContain('*Baseline finding* — first scan')
        expect(out.markdown).not.toContain('*New finding*')
    })

    it('marks a later finding as new', function () {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding(),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).toContain('*New finding*')
    })

    // Omitted entirely for a non-git project rather than rendered as "none".
    it('includes the branch line when the project has a branch', function () {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: 'main',
            finding: finding(),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).toContain('*Branch:* main')
    })

    it('omits the branch line entirely for a non-git project', function () {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding(),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).not.toContain('*Branch:*')
    })

    it.each([
        [{ fixStatus: 'released', fixAvailable: true, fixVersion: '4.17.21' }, ' → upgrade to 4.17.21'],
        [{ fixStatus: 'none_released' }, ' → No fixed version released — no published version of lodash is outside the vulnerable range (registry checked 2026-10-03)'],
        [{ fixStatus: 'unverified', fixAvailable: true, fixVersion: '4.17.21', fixCheck: { ...CHECK, registry: 'error' } }, ' → advisory names 4.17.21 as the fix · not checked against the registry (registry not reachable)'],
        [{ fixStatus: 'unverified', fixCheck: null }, ' → fix not re-checked yet — rescan pending']
    ] as Array<[Partial<Finding>, string]>)('renders the fix suffix %j as %s', function (overrides, expected) {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding(overrides),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).toContain('*Severity:* HIGH' + expected)
    })

    it('includes the advisory title and url when present', function () {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding({ advisoryTitle: 'Prototype pollution', advisoryUrl: 'https://ghsa.example/1' }),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).toContain('*Advisory:* Prototype pollution')
        expect(out.markdown).toContain('*Advisory URL:* https://ghsa.example/1')
    })

    it('omits the advisory lines when absent', function () {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding(),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).not.toContain('*Advisory:*')
        expect(out.markdown).not.toContain('*Advisory URL:*')
    })

    it('builds a portal link from the base url', function () {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding(),
            isBaseline: false,
            portalBaseUrl: BASE_URL
        })
        expect(out.portalUrl).toBe(BASE_URL + '/projects/project-1')
        expect(out.markdown).toContain('*Portal:* ' + BASE_URL + '/projects/project-1')
    })

    it('strips trailing slashes from the base url', function () {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding(),
            isBaseline: false,
            portalBaseUrl: BASE_URL + '///'
        })
        expect(out.portalUrl).toBe(BASE_URL + '/projects/project-1')
    })

    it('yields a null portal url when no base url is configured', function () {
        const out = renderSingleFinding({
            projectName: 'api',
            gitBranch: null,
            finding: finding(),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.portalUrl).toBeNull()
        expect(out.markdown).not.toContain('*Portal:*')
    })
})

describe('renderBatchedFindings', function () {
    it('lists every finding when there are eight or fewer', function () {
        const out = renderBatchedFindings({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            findings: manyFindings(8),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).toContain('pkg0')
        expect(out.markdown).toContain('pkg7')
        expect(out.markdown).not.toContain('…and')
    })

    // Truncation is real information loss, so the overflow count must be present and correct.
    it('truncates at eight and reports how many were dropped', function () {
        const out = renderBatchedFindings({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            findings: manyFindings(12),
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).toContain('pkg7')
        expect(out.markdown).not.toContain('pkg8')
        expect(out.markdown).toContain('…and 4 more')
    })

    it('formats each line with severity, package and advisory id', function () {
        const out = renderBatchedFindings({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            findings: [finding({ severity: 'critical' })],
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).toContain('• [CRITICAL] lodash@4.17.20 (GHSA-1) — No fixed version released')
    })

    it('includes the branch line when set', function () {
        const out = renderBatchedFindings({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: 'release/2.x',
            findings: [finding()],
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).toContain('*Branch:* release/2.x')
    })

    // text is the plain-text fallback for transports that do not render markdown, so the asterisks
    // that make the markdown readable must not leak into it.
    it('strips markdown emphasis from the plain-text body and title', function () {
        const out = renderBatchedFindings({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            findings: [finding()],
            isBaseline: false,
            portalBaseUrl: null
        })
        expect(out.markdown).toContain('*api*')
        expect(out.text).not.toContain('*')
        expect(out.title).toBe('Sentinello found vulnerabilities in api:')
    })

    it('appends the portal link when a base url is configured', function () {
        const out = renderBatchedFindings({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            findings: [finding()],
            isBaseline: false,
            portalBaseUrl: BASE_URL
        })
        expect(out.portalUrl).toBe(BASE_URL + '/projects/project-1')
        expect(out.markdown).toContain('Portal: ' + BASE_URL + '/projects/project-1')
    })
})

describe('renderScanFailure', function () {
    // Structured "status:reason_code" signatures are humanised; anything else passes through verbatim
    // so a legacy scrubbed error string is still readable.
    it('humanises a structured failure signature', function () {
        const out = renderScanFailure({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            event: scanFailureEvent({ failureSignature: 'error:no_lockfile' }),
            errorText: null,
            portalBaseUrl: null
        })
        expect(out.title).not.toContain('error:no_lockfile')
        expect(out.title.startsWith('[SCAN FAILED] api — ')).toBe(true)
    })

    it('passes a legacy one-liner signature through unchanged', function () {
        const out = renderScanFailure({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            event: scanFailureEvent({ failureSignature: 'npm ERR! code ELIFECYCLE' }),
            errorText: null,
            portalBaseUrl: null
        })
        expect(out.title).toBe('[SCAN FAILED] api — npm ERR! code ELIFECYCLE')
    })

    it('passes an unrecognised reason code through unchanged', function () {
        const out = renderScanFailure({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            event: scanFailureEvent({ failureSignature: 'error:not_a_real_code' }),
            errorText: null,
            portalBaseUrl: null
        })
        expect(out.title).toBe('[SCAN FAILED] api — error:not_a_real_code')
    })

    // `'error:'.split(':')` is still two parts, so the length check above lets it through with an EMPTY
    // reason code. That is a legacy row shape, not an impossible one — a truncated signature reaches
    // here and must pass through verbatim rather than being looked up as the empty reason code.
    it('passes a signature with an empty reason code through unchanged', function () {
        const out = renderScanFailure({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            event: scanFailureEvent({ failureSignature: 'error:' }),
            errorText: null,
            portalBaseUrl: null
        })
        expect(out.title).toBe('[SCAN FAILED] api — error:')
    })

    it('falls back to a generic signature when the event carries none', function () {
        const out = renderScanFailure({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            event: scanFailureEvent({ failureSignature: null }),
            errorText: null,
            portalBaseUrl: null
        })
        expect(out.title).toBe('[SCAN FAILED] api — unknown failure')
    })

    it('includes the scanner name and error text when present', function () {
        const out = renderScanFailure({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: 'main',
            event: scanFailureEvent(),
            errorText: 'exit code 1',
            portalBaseUrl: BASE_URL
        })
        expect(out.markdown).toContain('*Scanner:* npm-audit')
        expect(out.markdown).toContain('*Error:* exit code 1')
        expect(out.markdown).toContain('*Branch:* main')
        expect(out.portalUrl).toBe(BASE_URL + '/projects/project-1')
    })

    it('omits the error line when there is no error text', function () {
        const out = renderScanFailure({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            event: scanFailureEvent(),
            errorText: null,
            portalBaseUrl: null
        })
        expect(out.markdown).not.toContain('*Error:*')
    })

    it('strips markdown emphasis from the plain-text body', function () {
        const out = renderScanFailure({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            event: scanFailureEvent(),
            errorText: null,
            portalBaseUrl: null
        })
        expect(out.text).not.toContain('*')
    })
})

describe('the way out in a notification', function () {
    const remediation: Remediation = {
        v: 1, checkedAt: Date.UTC(2026, 9, 3), package: 'braces',
        health: { name: 'braces', latest: '3.0.3', lastPublishAt: Date.UTC(2024, 4, 21), maintainers: 2, weeklyDownloads: 1, deprecated: null, daysSinceLastPublish: 865, unmaintained: true },
        chains: [{ importer: '.', rootKind: 'dev', path: ['nodemon@3.1.14', 'chokidar@3.6.0', 'braces@3.0.3'], verdict: { kind: 'blocked', escapePackage: 'chokidar', escapeVersion: '4.0.0', blockedBy: 'nodemon', blockedByLatest: '3.1.14', blockedRange: '^3.5.2', proof: { release: 'chokidar@4.0.0', closureSize: 2 } } }],
        moreChains: 0, alternatives: [], devOnly: true, partial: false
    }
    const expected = 'braces is unmaintained → replace it; chokidar ≥ 4.0.0 drops braces, but no released nodemon admits it (latest 3.1.14 requires ^3.5.2); dev tooling only'

    it('adds one way-out line to a single none_released finding, and none otherwise', function () {
        const single = renderSingleFinding({ projectName: 'api', gitBranch: null, finding: finding({ packageName: 'braces', remediation }), isBaseline: false, portalBaseUrl: null })
        expect(single.markdown).toContain('*Way out:* ' + expected)
        const released = renderSingleFinding({ projectName: 'api', gitBranch: null, finding: finding({ fixStatus: 'released', fixVersion: '4.17.21', remediation }), isBaseline: false, portalBaseUrl: null })
        expect(released.markdown).not.toContain('Way out')
    })

    it('indents the way-out under its line in a batch', function () {
        const out = renderBatchedFindings({ projectName: 'api', projectId: 'project-1', gitBranch: null, findings: [finding({ packageName: 'braces', remediation }), finding({ id: 'f2' })], isBaseline: false, portalBaseUrl: null })
        expect(out.markdown).toContain('\n    Way out: ' + expected)
        expect(out.markdown.match(/Way out/g)).toHaveLength(1)
    })
})
