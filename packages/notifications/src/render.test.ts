import { describe, expect, it } from 'vitest'
import { CHAIN_UNKNOWN_TEXT, reasonCodeLabel, WAY_OUT_NPM_ONLY, type Capability, type Finding, type FixCheck, type Locale, type NotificationEvent, type Remediation } from '@sentinello/core'
import { renderBatchedFindings, renderCapabilitySummary, renderScanFailure, renderSingleFinding, type RenderBatchedFindingsInput } from './render'

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
        installations: [],
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
        expect(out.markdown).toContain('• [CRITICAL] lodash@4.17.20 (Node.js, GHSA-1) — No fixed version released')
        expect(out.markdown).not.toContain('In:')
    })

    // One finding for a library installed through two Gemfile.locks: the line names its language and every
    // manifest with its version, so the fix reaches each copy. An ecosystem the registry does not know is named
    // by its id.
    it('names the ecosystem and every manifest the library is installed through', function () {
        const rack = finding({ ecosystem: 'RubyGems', packageName: 'rack', installedVersion: '2.0.8', installations: [{ manifestPath: 'ios/Gemfile.lock', version: '2.0.8' }, { manifestPath: 'android/Gemfile.lock', version: '2.1.0' }] })
        const out = renderBatchedFindings({ projectName: 'app', projectId: 'project-1', gitBranch: null, findings: [rack, finding({ ecosystem: 'Hex' })], isBaseline: false, portalBaseUrl: null })
        expect(out.markdown).toContain('• [HIGH] rack@2.0.8 (Ruby, GHSA-1) — No fixed version released')
        expect(out.markdown).toContain('\n    In: ios/Gemfile.lock 2.0.8, android/Gemfile.lock 2.1.0')
        expect(out.markdown).toContain('lodash@4.17.20 (Hex, GHSA-1)')
        const single = renderSingleFinding({ projectName: 'app', gitBranch: null, finding: rack, isBaseline: false, portalBaseUrl: null })
        expect(single.markdown).toContain('*Package:* rack@2.0.8 (Ruby)\n*Installed through:* ios/Gemfile.lock 2.0.8, android/Gemfile.lock 2.1.0')
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

    // Some findings of a project that cannot be (fully) scanned are what an earlier scan left; the message
    // says so above them, in the notification locale.
    describe('the project\'s scan state', function () {
        function render(scanState: RenderBatchedFindingsInput['scanState'], locale?: Locale) {
            return renderBatchedFindings({ projectName: 'api', projectId: 'project-1', gitBranch: null, findings: [finding()], isBaseline: false, portalBaseUrl: null, scanState, locale })
        }

        it('heads a project that cannot be scanned with its reasons and whose fix they are', function () {
            const out = render({ state: 'cannot_scan', reasons: [{ source: 'npm-audit', ecosystem: null, reasonCode: 'no_lockfile', side: 'project', label: 'No lockfile' }] })
            expect(out.markdown).toContain('*Project cannot be scanned:* No lockfile (the project) — findings an earlier scan recorded are marked "not re-checked"')
        })

        it('heads a partially scanned project in the notification locale', function () {
            const out = render({ state: 'partial', reasons: [{ source: 'osv', ecosystem: null, reasonCode: 'osv_db_unavailable', side: 'environment', label: 'x' }] }, 'es')
            expect(out.markdown).toContain('*Project cannot be fully scanned:* ' + reasonCodeLabel('osv_db_unavailable', 'es') + ' (this Sentinello install)')
        })

        it('adds nothing for a scanned project or when no state is given', function () {
            expect(render({ state: 'scanned', reasons: [] }).markdown).not.toContain('Project ')
            expect(render(undefined).markdown).not.toContain('Project ')
        })
    })
})

describe('renderScanFailure', function () {
    // One source scans each ecosystem apart, so the message names the language of the scan that failed.
    it('names the ecosystem of the scan that failed', function () {
        const out = renderScanFailure({ projectName: 'api', projectId: 'project-1', gitBranch: null, event: scanFailureEvent({ failureSignature: 'error:osv_db_unavailable' }), errorText: null, portalBaseUrl: null, ecosystem: 'PyPI' })
        expect(out.title.startsWith('[SCAN FAILED] api (Python) — ')).toBe(true)
        expect(out.markdown).toContain('*Scanner:* ' + scanFailureEvent().scanner + ' (Python)')
        const unknown = renderScanFailure({ projectName: 'api', projectId: 'project-1', gitBranch: null, event: scanFailureEvent({ failureSignature: 'error:osv_db_unavailable' }), errorText: null, portalBaseUrl: null, ecosystem: null })
        expect(unknown.title.startsWith('[SCAN FAILED] api — ')).toBe(true)
    })

    // Structured "status:reason_code" signatures are humanised; anything else passes through verbatim
    // so a legacy scrubbed error string is still readable.
    it('humanises a structured failure signature', function () {
        const out = renderScanFailure({
            projectName: 'api',
            projectId: 'project-1',
            gitBranch: null,
            event: scanFailureEvent({ failureSignature: 'error:pm_missing' }),
            errorText: null,
            portalBaseUrl: null
        })
        expect(out.title).toBe('[SCAN FAILED] api — Package manager not on PATH')
        expect(out.markdown).toContain('*Failure:* Package manager not on PATH')
        expect(out.markdown).toContain('*Whose fix:* this Sentinello install')
    })

    // A cause on the project's side is not a scan that broke: the project cannot be scanned until someone
    // changes it, and the title says so.
    it('says a project cannot be scanned when the cause is on its side', function () {
        const out = renderScanFailure({
            projectName: 'ddns',
            projectId: 'project-1',
            gitBranch: null,
            event: scanFailureEvent({ failureSignature: 'unauditable:no_lockfile' }),
            errorText: null,
            portalBaseUrl: null
        })
        expect(out.title).toBe('[CANNOT BE SCANNED] ddns — No lockfile')
        expect(out.markdown).toContain('*Cannot be scanned:* *ddns*')
        expect(out.markdown).toContain('*Reason:* No lockfile')
        expect(out.markdown).toContain('*Whose fix:* the project')
        expect(out.markdown).not.toContain('Scan failed')
    })

    it('says a project cannot be scanned in the configured locale', function () {
        const out = renderScanFailure({
            projectName: 'ddns',
            projectId: 'project-1',
            gitBranch: null,
            event: scanFailureEvent({ failureSignature: 'unauditable:no_lockfile' }),
            errorText: null,
            portalBaseUrl: null,
            locale: 'es'
        })
        expect(out.title).toBe('[CANNOT BE SCANNED] ddns — Sin lockfile')
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
        moreChains: 0, moreChainsAtLeast: false, alternatives: [], devOnly: true
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

// The chain and the way-out verdict are separate facts (decision #6): a Gemfile.lock records the real chain
// even though the way out is computed for npm only, and a requirements.txt records no chain at all, which is
// said whatever the fix status.
describe('the dependency chain in a notification', function () {
    const npmOnly: Remediation = {
        v: 1, checkedAt: Date.UTC(2026, 9, 3), package: 'rack',
        health: { name: 'rack', latest: null, lastPublishAt: null, maintainers: 0, weeklyDownloads: null, deprecated: null, daysSinceLastPublish: null, unmaintained: false },
        chains: [{ importer: null, rootKind: null, path: [], verdict: { kind: 'unknown', at: 'rack', reason: WAY_OUT_NPM_ONLY } }],
        moreChains: 0, moreChainsAtLeast: false, alternatives: [], devOnly: null
    }
    const npmVerdict: Remediation = {
        v: 1, checkedAt: Date.UTC(2026, 9, 3), package: 'braces',
        health: { name: 'braces', latest: '3.0.3', lastPublishAt: Date.UTC(2024, 4, 21), maintainers: 2, weeklyDownloads: 1, deprecated: null, daysSinceLastPublish: 30, unmaintained: false },
        chains: [{ importer: '.', rootKind: 'prod', path: ['nodemon@3.1.14', 'chokidar@3.6.0', 'braces@3.0.3'], verdict: { kind: 'blocked', escapePackage: 'chokidar', escapeVersion: '4.0.0', blockedBy: 'nodemon', blockedByLatest: '3.1.14', blockedRange: '^3.5.2', proof: { release: 'chokidar@4.0.0', closureSize: 2 } } }],
        moreChains: 0, moreChainsAtLeast: false, alternatives: [], devOnly: false
    }
    const npm = finding({ packageName: 'braces', installedVersion: '3.0.3', depPath: ['nodemon', 'chokidar', 'braces'], remediation: npmVerdict })
    const ruby = finding({ ecosystem: 'RubyGems', packageName: 'rack', installedVersion: '2.0.8', depPath: ['rails', 'actionpack', 'rack'], remediation: npmOnly })
    const python = finding({ ecosystem: 'PyPI', packageName: 'django', installedVersion: '4.2.0', depPath: [], fixStatus: 'released', fixAvailable: true, fixVersion: '4.2.1' })

    function single(f: Finding): string {
        return renderSingleFinding({ projectName: 'app', gitBranch: null, finding: f, isBaseline: false, portalBaseUrl: null }).markdown
    }

    it('shows an npm finding\'s chain beside its computed verdict', function () {
        expect(single(npm)).toContain('*Dependency path:* nodemon › chokidar › braces')
        expect(single(npm)).toContain('*Way out:* chokidar ≥ 4.0.0 drops braces')
    })

    it('shows a Ruby finding\'s real chain, and says its way out is not computed', function () {
        expect(single(ruby)).toContain('*Dependency path:* rails › actionpack › rack')
        expect(single(ruby)).toContain('*Way out:* unknown — ' + WAY_OUT_NPM_ONLY)
        expect(single(ruby)).not.toContain(CHAIN_UNKNOWN_TEXT)
    })

    // A released fix has no way-out line, so the qualification must not hang off it.
    it('says a requirements.txt finding\'s chain is unknown, even with a released fix', function () {
        expect(single(python)).toContain('*Dependency path:* ' + CHAIN_UNKNOWN_TEXT)
        expect(single(python)).not.toContain('Way out')
    })

    it('carries each chain under its line in a batch', function () {
        const out = renderBatchedFindings({ projectName: 'app', projectId: 'project-1', gitBranch: null, findings: [npm, ruby, python], isBaseline: false, portalBaseUrl: null })
        expect(out.markdown).toContain('(registry checked 2026-10-03)\n    Path: nodemon › chokidar › braces\n    Way out: chokidar ≥ 4.0.0')
        expect(out.markdown).toContain('(registry checked 2026-10-03)\n    Path: rails › actionpack › rack\n    Way out: unknown — ' + WAY_OUT_NPM_ONLY)
        expect(out.markdown).toContain('django@4.2.0 (Python, GHSA-1) — upgrade to 4.2.1\n    Path: ' + CHAIN_UNKNOWN_TEXT)
    })
})

describe('renderCapabilitySummary', function () {
    const capability = { id: 'languages-3.8', since: '3.8.0', ecosystems: ['PyPI', 'Go', 'crates.io', 'RubyGems'] as Capability['ecosystems'] }

    it('says what the new languages found and where to turn a source on', function () {
        const message = renderCapabilitySummary({ capability, findings: 12, projects: 3, critical: 2, sourceDisabledProjects: 4, portalBaseUrl: 'https://sentinello.example/' })
        expect(message.title).toBe('Sentinello 3.8 now checks Python/Go/Rust/Ruby')
        expect(message.text).toBe([
            'Sentinello 3.8 now checks Python/Go/Rust/Ruby: 12 findings across 3 projects, 2 critical',
            '4 projects have no enabled source, turn one on in Settings → Sources',
            'Portal: https://sentinello.example/settings/sources'
        ].join('\n'))
        expect(message.portalUrl).toBe('https://sentinello.example/settings/sources')
    })

    // The default install: OSV and gemnasium are opt-in, so nothing was checked — and the summary says so.
    it('reports zero findings honestly, in the singular where it applies', function () {
        const message = renderCapabilitySummary({ capability, findings: 0, projects: 0, critical: 0, sourceDisabledProjects: 1, portalBaseUrl: null })
        expect(message.text).toBe('Sentinello 3.8 now checks Python/Go/Rust/Ruby: 0 findings across 0 projects, 0 critical\n1 project has no enabled source, turn one on in Settings → Sources')
        expect(message.portalUrl).toBeNull()
        expect(renderCapabilitySummary({ capability, findings: 1, projects: 1, critical: 1, sourceDisabledProjects: 0, portalBaseUrl: null }).text)
            .toBe('Sentinello 3.8 now checks Python/Go/Rust/Ruby: 1 finding across 1 project, 1 critical')
    })

    it('carries the capability and its counts for a webhook', function () {
        expect(renderCapabilitySummary({ capability, findings: 12, projects: 3, critical: 2, sourceDisabledProjects: 4, portalBaseUrl: null }).webhook).toEqual({
            event: 'capability_summary',
            capability: { id: 'languages-3.8', since: '3.8.0', ecosystems: ['PyPI', 'Go', 'crates.io', 'RubyGems'] },
            counts: { findings: 12, projects: 3, critical: 2, sourceDisabledProjects: 4 }
        })
    })

    // Every locale words its own plurals; printed per locale so a misfiled translation is visible.
    it.each([
        ['es', 'Sentinello 3.8 ahora revisa Python/Go/Rust/Ruby: 1 hallazgo en 1 proyecto, 1 crítico', '1 proyecto no tiene ninguna fuente activada, activa una en Configuración → Fuentes', '2 hallazgos en 3 proyectos, 0 críticos', '2 proyectos no tienen'],
        ['fr', 'Sentinello 3.8 vérifie désormais Python/Go/Rust/Ruby: 1 vulnérabilité dans 1 projet, dont 1 critique', '1 projet n’a aucune source activée, activez-en une dans Paramètres → Sources', '2 vulnérabilités dans 3 projets, dont 0 critique', '2 projets n’ont'],
        ['de', 'Sentinello 3.8 prüft jetzt Python/Go/Rust/Ruby: 1 Befund in 1 Projekt, 1 kritisch', '1 Projekt hat keine aktivierte Quelle, aktivieren Sie eine unter Einstellungen → Quellen', '2 Befunde in 3 Projekten, 0 kritisch', '2 Projekte haben'],
        ['pt-BR', 'Sentinello 3.8 agora verifica Python/Go/Rust/Ruby: 1 achado em 1 projeto, 1 crítico', '1 projeto não tem nenhuma fonte ativada, ative uma em Configurações → Fontes', '2 achados em 3 projetos, 0 críticos', '2 projetos não têm'],
        ['it', 'Sentinello 3.8 ora controlla Python/Go/Rust/Ruby: 1 vulnerabilità trovata in 1 progetto, 1 critica', '1 progetto non ha alcuna fonte attivata, attivane una in Impostazioni → Fonti', '2 vulnerabilità trovate in 3 progetti, 0 critiche', '2 progetti non hanno'],
        ['ja', 'Sentinello 3.8 は Python/Go/Rust/Ruby もチェックするようになりました: 1 件のプロジェクトで 1 件の検出、うち重大 1 件', '1 件のプロジェクトで有効なソースがありません。設定 → ソースで有効にしてください', '3 件のプロジェクトで 2 件の検出、うち重大 0 件', '2 件のプロジェクト'],
        ['zh-CN', 'Sentinello 3.8 现已检查 Python/Go/Rust/Ruby: 1 个项目中有 1 个发现，其中 1 个严重', '1 个项目没有已启用的来源，请在 设置 → 来源 中启用一个', '3 个项目中有 2 个发现，其中 0 个严重', '2 个项目'],
        ['ko', 'Sentinello 3.8부터 Python/Go/Rust/Ruby도 검사합니다: 프로젝트 1개에서 발견 항목 1개, 그중 심각 1개', '프로젝트 1개에 활성화된 소스가 없습니다. 설정 → 소스에서 하나를 켜세요', '프로젝트 3개에서 발견 항목 2개, 그중 심각 0개', '프로젝트 2개'],
        ['ru', 'Sentinello 3.8 теперь проверяет Python/Go/Rust/Ruby: 1 находка в 1 проекте, 1 критическая', 'В 1 проекте нет включённого источника, включите его в Настройки → Источники', '2 находки в 3 проектах, 0 критических', 'В 2 проектах']
    ] as const)('words the summary in %s', function (locale, one, disabledOne, many, disabledMany) {
        const first = renderCapabilitySummary({ capability, findings: 1, projects: 1, critical: 1, sourceDisabledProjects: 1, portalBaseUrl: null, locale })
        expect(first.text).toBe(one + '\n' + disabledOne)
        const second = renderCapabilitySummary({ capability, findings: 2, projects: 3, critical: 0, sourceDisabledProjects: 2, portalBaseUrl: null, locale })
        expect(second.text).toContain(many)
        expect(second.text).toContain(disabledMany)
    })

    it('reads Russian plurals by their last digits', function () {
        expect(renderCapabilitySummary({ capability, findings: 5, projects: 21, critical: 22, sourceDisabledProjects: 0, portalBaseUrl: null, locale: 'ru' }).text).toContain('5 находок в 21 проекте, 22 критических')
    })
})
