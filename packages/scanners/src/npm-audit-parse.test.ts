import { describe, expect, it } from 'vitest'
import {
    buildBashWrappedCommand,
    classifyNvmWrapperFailure,
    classifyPackageManagerNotFound,
    fallbackAdvisoryHash,
    looksLikeLegacyShape,
    normalizeAuditOutput,
    normalizePnpmAuditOutput,
    parseYarnMajor,
    pickAdvisoryId,
    pickAuditCommand,
    pickDepPath,
    pickFixAvailability,
    pickGhsaIdFromUrl,
    pickInstalledVersion,
    pickPnpmAdvisoryId,
    pickSeverity,
    pickVulnerableRange
} from './npm-audit-parse'
import type { DepClassifier, ModernAudit, PnpmAudit, Vulnerability, ViaObject } from './npm-audit-parse'
import type { DetectedLockfile } from './types'

// Everything a scan decides about a package — its advisory id, its severity, whether the run was
// unauditable and why — is computed here, with no child process involved.

const PROD_CLASSIFIER: DepClassifier = {
    classify() {
        return { isProd: true, isDev: false }
    }
}

function lockfile(packageManager: DetectedLockfile['packageManager'], kind: DetectedLockfile['kind']): DetectedLockfile {
    return { kind, packageManager, absolutePath: '/repo/' + kind }
}

function vuln(overrides: Partial<Vulnerability> = {}): Vulnerability {
    return { name: 'lodash', via: [], ...overrides } as Vulnerability
}

function via(overrides: Partial<ViaObject> = {}): ViaObject {
    return { ...overrides } as ViaObject
}

describe('pickAuditCommand', function () {
    it('picks the command matching the detected package manager', function () {
        expect(pickAuditCommand(lockfile('npm', 'package-lock.json'))).toBe('npm audit --json')
        expect(pickAuditCommand(lockfile('pnpm', 'pnpm-lock.yaml'))).toBe('pnpm audit --json')
        expect(pickAuditCommand(lockfile('yarn', 'yarn.lock'))).toBe('yarn npm audit --json')
    })
})

describe('buildBashWrappedCommand', function () {
    // nvm's own progress chatter goes to STDOUT, which would prepend non-JSON noise to the audit
    // output and break parsing. The 1>&2 redirect is load-bearing, not cosmetic.
    it('sources nvm and redirects nvm chatter to stderr', function () {
        const wrapped = buildBashWrappedCommand('npm audit --json')
        expect(wrapped.cmd).toBe('bash')
        expect(wrapped.args[0]).toBe('-lc')
        expect(wrapped.args[1]).toContain('source ~/.nvm/nvm.sh')
        expect(wrapped.args[1]).toContain('nvm install 1>&2')
        expect(wrapped.args[1]).toContain('npm audit --json')
    })
})

describe('classifyNvmWrapperFailure', function () {
    it('recognises every shape of "nvm is not installed"', function () {
        const cases = [
            'bash: /root/.nvm/nvm.sh: No such file or directory',
            '-bash: line 1: nvm: command not found',
            'zsh:1: command not found: nvm'
        ]
        for (const stderr of cases) {
            const result = classifyNvmWrapperFailure(stderr)
            expect(result, stderr).not.toBeNull()
            expect(result?.reasonCode, stderr).toBe('nvm_missing')
            // A missing toolchain is unauditable rather than an error: nothing is broken, we just
            // cannot answer for this project.
            expect(result?.kind, stderr).toBe('unauditable')
        }
    })

    it('recognises an upstream version that does not exist', function () {
        const result = classifyNvmWrapperFailure('Version "v99.0.0" not found - try `nvm ls-remote`')
        expect(result?.reasonCode).toBe('nvm_install_failed')
        expect(result?.kind).toBe('error')
    })

    it('recognises a failed download or checksum', function () {
        expect(classifyNvmWrapperFailure('Binary download failed, trying source.')?.reasonCode).toBe('nvm_install_failed')
        expect(classifyNvmWrapperFailure('Checksum check failed!')?.reasonCode).toBe('nvm_install_failed')
    })

    it('recognises an install that silently did not take', function () {
        expect(classifyNvmWrapperFailure('N/A: version "v20" is not yet installed')?.reasonCode).toBe('nvm_install_failed')
    })

    // Unmatched stderr must return null so the caller falls through to its generic handling rather
    // than mislabelling an unrelated failure as an nvm problem.
    it('returns null for unrelated stderr', function () {
        expect(classifyNvmWrapperFailure('')).toBeNull()
        expect(classifyNvmWrapperFailure('npm ERR! code ELIFECYCLE')).toBeNull()
        expect(classifyNvmWrapperFailure('some other error')).toBeNull()
    })
})

describe('classifyPackageManagerNotFound', function () {
    it('detects a missing package manager in both shell dialects', function () {
        expect(classifyPackageManagerNotFound('bash: line 1: pnpm: command not found', 'pnpm')).toBe(true)
        expect(classifyPackageManagerNotFound('zsh:1: command not found: pnpm', 'pnpm')).toBe(true)
    })

    it('does not match a different package manager', function () {
        expect(classifyPackageManagerNotFound('bash: line 1: pnpm: command not found', 'npm')).toBe(false)
    })

    it('returns false for unrelated stderr', function () {
        expect(classifyPackageManagerNotFound('npm ERR! network timeout', 'npm')).toBe(false)
    })
})

describe('parseYarnMajor', function () {
    it('reads the major from a packageManager field', function () {
        expect(parseYarnMajor('yarn@4.1.0')).toBe(4)
        expect(parseYarnMajor('yarn@1.22.19')).toBe(1)
        expect(parseYarnMajor('yarn@3')).toBe(3)
    })

    it('returns null for another package manager or a non-string', function () {
        expect(parseYarnMajor('pnpm@10.0.0')).toBeNull()
        expect(parseYarnMajor(undefined)).toBeNull()
        expect(parseYarnMajor(42)).toBeNull()
        expect(parseYarnMajor('yarn')).toBeNull()
    })
})

describe('pickGhsaIdFromUrl and pickAdvisoryId', function () {
    it('extracts a GHSA id from an advisory url, case-insensitively', function () {
        expect(pickGhsaIdFromUrl('https://github.com/advisories/GHSA-xxxx-yyyy-zzzz')).toBe('GHSA-xxxx-yyyy-zzzz')
        expect(pickGhsaIdFromUrl('https://example.test/nope')).toBeNull()
        expect(pickGhsaIdFromUrl(undefined)).toBeNull()
    })

    it('prefers a numeric source id', function () {
        expect(pickAdvisoryId(via({ source: 1234, url: 'https://github.com/advisories/GHSA-a-b-c' }))).toBe('1234')
    })

    it('falls back to the GHSA id in the url', function () {
        expect(pickAdvisoryId(via({ url: 'https://github.com/advisories/GHSA-a-b-c' }))).toBe('GHSA-a-b-c')
    })

    // A stable hash keeps an otherwise unidentifiable advisory from churning a new id every scan,
    // which would make it look resolved-and-reopened on every run.
    it('derives a stable hash when no id is available', function () {
        const subject = via({ title: 'Some advisory' })
        const first = pickAdvisoryId(subject)
        expect(first).toMatch(/^npmaudit-hash-[0-9a-f]{16}$/)
        expect(pickAdvisoryId(subject)).toBe(first)
    })

    it('distinguishes different advisories in the hash', function () {
        expect(pickAdvisoryId(via({ title: 'A' }))).not.toBe(pickAdvisoryId(via({ title: 'B' })))
    })

    it('returns null when there is nothing at all to identify', function () {
        expect(pickAdvisoryId(via())).toBeNull()
    })
})

describe('pickSeverity, pickFixAvailability, pickVulnerableRange', function () {
    it('prefers the via severity over the vulnerability severity, defaulting to info', function () {
        expect(pickSeverity(via({ severity: 'critical' }), vuln({ severity: 'low' }))).toBe('critical')
        expect(pickSeverity(via(), vuln({ severity: 'low' }))).toBe('low')
        expect(pickSeverity(via(), vuln())).toBe('info')
    })

    it('reads fix availability from all three shapes', function () {
        expect(pickFixAvailability(undefined)).toEqual({ fixAvailable: false, fixVersion: null })
        expect(pickFixAvailability(false)).toEqual({ fixAvailable: false, fixVersion: null })
        // `true` means "a fix exists" without naming a version.
        expect(pickFixAvailability(true)).toEqual({ fixAvailable: true, fixVersion: null })
        expect(pickFixAvailability({ name: 'lodash', version: '4.17.21', isSemVerMajor: false })).toEqual({
            fixAvailable: true,
            fixVersion: '4.17.21'
        })
        // A fix object carrying an empty version still means "a fix exists", but there is no version
        // to name — the empty string must not reach the UI as the suggested upgrade target.
        expect(pickFixAvailability({ name: 'lodash', version: '', isSemVerMajor: false })).toEqual({
            fixAvailable: true,
            fixVersion: null
        })
    })

    it('prefers the via range over the vulnerability range, defaulting to empty', function () {
        expect(pickVulnerableRange(via({ range: '<1.0.0' }), vuln({ range: '<2.0.0' }))).toBe('<1.0.0')
        expect(pickVulnerableRange(via(), vuln({ range: '<2.0.0' }))).toBe('<2.0.0')
        expect(pickVulnerableRange(via(), vuln())).toBe('')
    })
})

describe('pickInstalledVersion', function () {
    it('resolves node paths through the lockfile version map', function () {
        const versions = new Map([['node_modules/lodash', '4.17.11']])
        expect(pickInstalledVersion(vuln({ nodes: ['node_modules/lodash'] }), versions)).toBe('4.17.11')
    })

    // npm hoisting can leave duplicate copies at different versions; the UI shows all of them.
    it('joins distinct versions when a package is installed more than once', function () {
        const versions = new Map([
            ['node_modules/lodash', '4.0.0'],
            ['node_modules/x/node_modules/lodash', '4.5.0']
        ])
        const result = pickInstalledVersion(vuln({ nodes: ['node_modules/lodash', 'node_modules/x/node_modules/lodash'] }), versions)
        expect(result).toBe('4.0.0, 4.5.0')
    })

    it('collapses duplicate copies at the same version', function () {
        const versions = new Map([
            ['node_modules/a', '1.0.0'],
            ['node_modules/b', '1.0.0']
        ])
        expect(pickInstalledVersion(vuln({ nodes: ['node_modules/a', 'node_modules/b'] }), versions)).toBe('1.0.0')
    })

    // Preserves the pre-lockfile behaviour for projects whose lock cannot be parsed.
    it('falls back to the vulnerable range when no lookup is possible', function () {
        expect(pickInstalledVersion(vuln({ nodes: ['node_modules/lodash'], range: '<4.17.21' }), new Map())).toBe('<4.17.21')
        expect(pickInstalledVersion(vuln({ range: '<4.17.21' }), new Map())).toBe('<4.17.21')
        expect(pickInstalledVersion(vuln(), new Map())).toBe('')
    })

    // A populated map that simply has no entry for these nodes is a different case from an empty
    // one: the lookup was possible and found nothing, so the range fallback still has to fire.
    it('falls back when the map is populated but matches none of the nodes', function () {
        const versions = new Map([['node_modules/express', '4.0.0']])
        expect(pickInstalledVersion(vuln({ nodes: ['node_modules/lodash'], range: '<4.17.21' }), versions)).toBe('<4.17.21')
        expect(pickInstalledVersion(vuln({ nodes: ['node_modules/lodash'] }), versions)).toBe('')
    })
})

describe('pickDepPath', function () {
    it('returns the node paths, or an empty list', function () {
        expect(pickDepPath(vuln({ nodes: ['node_modules/a', 'node_modules/b'] }))).toEqual(['node_modules/a', 'node_modules/b'])
        expect(pickDepPath(vuln())).toEqual([])
        expect(pickDepPath(vuln({ nodes: [] }))).toEqual([])
    })
})

describe('normalizeAuditOutput — the npm 7+ shape', function () {
    function audit(vulnerabilities: Record<string, unknown>): ModernAudit {
        return { auditReportVersion: 2, vulnerabilities } as ModernAudit
    }

    it('builds a finding per concrete advisory', function () {
        const result = normalizeAuditOutput(
            audit({
                lodash: {
                    name: 'lodash',
                    severity: 'high',
                    range: '<4.17.21',
                    nodes: ['node_modules/lodash'],
                    fixAvailable: { name: 'lodash', version: '4.17.21', isSemVerMajor: false },
                    via: [{ source: 1065, title: 'Prototype Pollution', url: 'https://github.com/advisories/GHSA-p6mc', severity: 'high', range: '<4.17.21' }]
                }
            }),
            new Map([['node_modules/lodash', '4.17.11']]),
            PROD_CLASSIFIER
        )

        expect(result.findings).toHaveLength(1)
        expect(result.findings[0]).toMatchObject({
            advisoryId: '1065',
            advisoryTitle: 'Prototype Pollution',
            packageName: 'lodash',
            installedVersion: '4.17.11',
            severity: 'high',
            isProd: true
        })
        expect(result.hadVulnerabilityWithoutConcreteAdvisory).toBe(false)
    })

    // A `via` entry that is a bare string is a transitive pointer to another vulnerable package,
    // not an advisory of its own — it must not become a finding.
    it('ignores string via entries', function () {
        const result = normalizeAuditOutput(
            audit({ a: { name: 'a', via: ['lodash'], severity: 'high' } }),
            new Map(),
            PROD_CLASSIFIER
        )
        expect(result.findings).toEqual([])
        expect(result.hadVulnerabilityWithoutConcreteAdvisory).toBe(true)
    })

    it('flags a vulnerability with an empty via list', function () {
        const result = normalizeAuditOutput(audit({ a: { name: 'a', via: [] } }), new Map(), PROD_CLASSIFIER)
        expect(result.findings).toEqual([])
        expect(result.hadVulnerabilityWithoutConcreteAdvisory).toBe(true)
    })

    it('emits one finding per advisory when a package has several', function () {
        const result = normalizeAuditOutput(
            audit({
                lodash: {
                    name: 'lodash',
                    severity: 'high',
                    via: [{ source: 1, title: 'A' }, { source: 2, title: 'B' }]
                }
            }),
            new Map(),
            PROD_CLASSIFIER
        )
        expect(result.findings.map(function id(f) { return f.advisoryId })).toEqual(['1', '2'])
    })

    it('returns nothing for an audit with no vulnerabilities', function () {
        expect(normalizeAuditOutput(audit({}), new Map(), PROD_CLASSIFIER).findings).toEqual([])
    })

    // npm can report "no fix available" while the range's upper bound still implies one.
    it('derives a fix from the vulnerable range when npm named none', function () {
        const result = normalizeAuditOutput(
            audit({
                lodash: { name: 'lodash', severity: 'high', range: '<=5.2.1', fixAvailable: false, via: [{ source: 1, range: '<=5.2.1' }] }
            }),
            new Map(),
            PROD_CLASSIFIER
        )
        expect(result.findings[0]?.fixVersion).toBe('5.2.2')
        expect(result.findings[0]?.fixAvailable).toBe(true)
    })
})

describe('normalizePnpmAuditOutput — the pnpm shape', function () {
    it('builds a finding per dependency path', function () {
        const parsed = {
            advisories: {
                '1065': {
                    id: 1065,
                    github_advisory_id: 'GHSA-p6mc-m468-83gg',
                    module_name: 'lodash',
                    severity: 'high',
                    title: 'Prototype Pollution',
                    url: 'https://example.test/1065',
                    vulnerable_versions: '<4.17.21',
                    findings: [{ version: '4.17.11', paths: ['app>lodash', 'app>x>lodash'] }]
                }
            }
        } as unknown as PnpmAudit

        const findings = normalizePnpmAuditOutput(parsed, PROD_CLASSIFIER)
        expect(findings).toHaveLength(2)
        expect(findings[0]?.advisoryId).toBe('GHSA-p6mc-m468-83gg')
        expect(findings[0]?.installedVersion).toBe('4.17.11')
        expect(findings[0]?.depPath).toEqual(['app', 'lodash'])
        expect(findings[1]?.depPath).toEqual(['app', 'x', 'lodash'])
    })

    it('still emits one finding when an advisory has no findings array', function () {
        const parsed = {
            advisories: { '1': { id: 1, module_name: 'lodash', severity: 'low', vulnerable_versions: '<2.0.0' } }
        } as unknown as PnpmAudit
        const findings = normalizePnpmAuditOutput(parsed, PROD_CLASSIFIER)
        expect(findings).toHaveLength(1)
        expect(findings[0]?.installedVersion).toBe('')
    })

    // pnpm omits keys rather than emitting empty ones, so a sparse advisory is the normal shape for
    // an entry it knows little about. Every optional field has to degrade to its empty spelling
    // instead of reaching the finding as undefined and rendering as "undefined" in the portal.
    it('fills in every omitted advisory field', function () {
        const parsed = {
            advisories: {
                '7': { id: 7, module_name: 'lodash', findings: [{}] }
            }
        } as unknown as PnpmAudit
        const findings = normalizePnpmAuditOutput(parsed, PROD_CLASSIFIER)
        expect(findings).toHaveLength(1)
        expect(findings[0]).toMatchObject({
            advisoryId: '7',
            advisoryTitle: null,
            advisoryUrl: null,
            packageName: 'lodash',
            installedVersion: '',
            vulnerableRange: '',
            severity: 'info',
            fixAvailable: false,
            fixVersion: null,
            depPath: []
        })
    })

    // A findings entry with a version but no paths still describes an installed copy — it just has
    // no dependency chain to attribute it to. Dropping it would lose the finding entirely.
    it('emits a finding for a findings entry with no paths', function () {
        const parsed = {
            advisories: {
                '8': { id: 8, module_name: 'lodash', vulnerable_versions: '<4.17.21', findings: [{ version: '4.17.11' }] }
            }
        } as unknown as PnpmAudit
        const findings = normalizePnpmAuditOutput(parsed, PROD_CLASSIFIER)
        expect(findings).toHaveLength(1)
        expect(findings[0]?.installedVersion).toBe('4.17.11')
        expect(findings[0]?.depPath).toEqual([])
    })

    it('returns nothing for an empty advisories map', function () {
        expect(normalizePnpmAuditOutput({ advisories: {} } as unknown as PnpmAudit, PROD_CLASSIFIER)).toEqual([])
    })

    it('prefers a GHSA id, then the url, then the numeric id, then the key', function () {
        const advisory = { module_name: 'x', id: 7 }
        expect(pickPnpmAdvisoryId({ ...advisory, github_advisory_id: 'GHSA-a-b-c' } as never, '7')).toBe('GHSA-a-b-c')
        expect(pickPnpmAdvisoryId({ ...advisory, url: 'https://github.com/advisories/GHSA-d-e-f' } as never, '7')).toBe('GHSA-d-e-f')
        expect(pickPnpmAdvisoryId(advisory as never, '7')).toBe('7')
        expect(pickPnpmAdvisoryId({ module_name: 'x' } as never, '99')).toBe('npmaudit-99')
    })
})

describe('looksLikeLegacyShape — npm 6 detection', function () {
    // npm 6's envelope must be recognised so the scan reports npm_below_min rather than parsing
    // it as modern output and silently reporting zero findings.
    it('recognises the legacy envelope', function () {
        expect(looksLikeLegacyShape(JSON.stringify({ advisories: { '1': {} } }))).toBe(true)
        expect(looksLikeLegacyShape(JSON.stringify({ actions: [] }))).toBe(true)
    })

    it('does not mistake modern output for legacy', function () {
        expect(looksLikeLegacyShape(JSON.stringify({ vulnerabilities: {}, auditReportVersion: 2 }))).toBe(false)
        // pnpm's envelope carries BOTH keys; the modern marker wins.
        expect(looksLikeLegacyShape(JSON.stringify({ advisories: {}, vulnerabilities: {} }))).toBe(false)
    })

    it('returns false for anything that is not a JSON object', function () {
        expect(looksLikeLegacyShape('')).toBe(false)
        expect(looksLikeLegacyShape('not json')).toBe(false)
        expect(looksLikeLegacyShape('[]')).toBe(false)
        expect(looksLikeLegacyShape('{ broken')).toBe(false)
    })

    // An object carrying those key names at the wrong TYPE is some other tool's JSON, not npm 6.
    // Accepting it would report npm_below_min for a project on a perfectly current npm.
    it('returns false when the legacy keys are present at the wrong type', function () {
        expect(looksLikeLegacyShape(JSON.stringify({ actions: 'nope' }))).toBe(false)
        expect(looksLikeLegacyShape(JSON.stringify({ advisories: 42 }))).toBe(false)
    })

    it('tolerates leading whitespace', function () {
        expect(looksLikeLegacyShape('\n  ' + JSON.stringify({ advisories: {} }))).toBe(true)
    })
})

describe('fallbackAdvisoryHash', function () {
    // Reached when an advisory has neither a numeric source nor a GHSA-shaped URL — a private
    // registry, or a mirror that rewrites the advisory link. The id becomes the finding's identity
    // key, so it has to be stable across scans (or every scan reopens the same finding as new) and
    // distinct between advisories (or two get merged into one episode).
    it('is stable for the same advisory', function () {
        const v = via({ url: 'https://registry.internal/adv/7', title: 'Prototype pollution' })
        expect(fallbackAdvisoryHash(v)).toBe(fallbackAdvisoryHash(via({ url: 'https://registry.internal/adv/7', title: 'Prototype pollution' })))
    })

    it.each([
        ['the url', { url: 'https://registry.internal/adv/8', title: 'Prototype pollution' }],
        ['the title', { url: 'https://registry.internal/adv/7', title: 'Something else' }],
        ['the source', { source: 'abc', url: 'https://registry.internal/adv/7', title: 'Prototype pollution' }]
    ])('differs when %s differs', function (_label, overrides) {
        const base = fallbackAdvisoryHash(via({ url: 'https://registry.internal/adv/7', title: 'Prototype pollution' }))
        expect(fallbackAdvisoryHash(via(overrides as Partial<ViaObject>))).not.toBe(base)
    })

    it('is prefixed so it is recognisable as synthesised rather than upstream', function () {
        expect(fallbackAdvisoryHash(via({ title: 'x' }))).toMatch(/^npmaudit-hash-[0-9a-f]{16}$/)
    })

    // Absent fields must not collapse into each other: {url: 'a'} and {title: 'a'} are different
    // advisories and a naive join would hash them identically.
    it('distinguishes a value in one field from the same value in another', function () {
        expect(fallbackAdvisoryHash(via({ url: 'a' }))).not.toBe(fallbackAdvisoryHash(via({ title: 'a' })))
    })

    it('is reached through pickAdvisoryId when there is no id and no GHSA url', function () {
        expect(pickAdvisoryId(via({ url: 'https://registry.internal/adv/7' }))).toMatch(/^npmaudit-hash-/)
    })

    // The genuinely empty case stays null so the caller can skip the entry rather than minting an id
    // for an advisory that says nothing at all.
    it('is not reached when every field is absent', function () {
        expect(pickAdvisoryId(via({}))).toBeNull()
    })
})

describe('classifyNvmWrapperFailure — the remaining spellings', function () {
    // Each of these is a different shell or nvm version reporting the same condition. Missing one
    // downgrades a precise "install nvm" into a generic unknown failure with raw bash output.
    it.each([
        ['a path-form nvm.sh miss', 'bash: line 1: /home/app/.nvm/nvm.sh: No such file or directory'],
        ['zsh command-not-found ordering', 'zsh: command not found: nvm'],
        ['a bare nvm command-not-found', 'sh: 1: nvm: command not found']
    ])('classifies %s as nvm_missing', function (_label, stderr) {
        expect(classifyNvmWrapperFailure(stderr as string)).toMatchObject({ kind: 'unauditable', reasonCode: 'nvm_missing' })
    })

    it.each([
        ['an N/A install result', 'N/A: version "v18.0.0 -> N/A" is not yet installed'],
        ['a bare N/A line mentioning nvm', 'nvm: N/A: this version is not available'],
        ['a checksum failure', 'Checksum check failed!'],
        ['a download failure', 'Downloading https://nodejs.org/dist/v18.0.0/node-v18.0.0.tar.xz failed']
    ])('classifies %s as nvm_install_failed', function (_label, stderr) {
        expect(classifyNvmWrapperFailure(stderr as string)).toMatchObject({ kind: 'error', reasonCode: 'nvm_install_failed' })
    })

    // "nvm" appearing in an unrelated line must not be enough on its own — the N/A rule needs both
    // halves, or an ordinary log line mentioning a path with .nvm in it would be misclassified.
    it('does not classify an unrelated failure', function () {
        expect(classifyNvmWrapperFailure('npm ERR! code ELIFECYCLE')).toBeNull()
        expect(classifyNvmWrapperFailure('N/A: something with no mention of the version manager')).toBeNull()
    })
})

describe('parseYarnMajor — the rejected spellings', function () {
    it.each([
        ['a non-string', 42],
        ['an empty string', ''],
        ['a different package manager', 'pnpm@9.0.0'],
        ['no version', 'yarn'],
        ['a non-numeric major', 'yarn@latest']
    ])('returns null for %s', function (_label, value) {
        expect(parseYarnMajor(value)).toBeNull()
    })

    it('reads the major from a hash-suffixed corepack spelling', function () {
        expect(parseYarnMajor('yarn@4.1.0+sha224.abcdef')).toBe(4)
    })
})

describe('pickInstalledVersion — several resolved nodes', function () {
    // A package can appear at several depths with different versions. All of them are reported, so
    // an operator can see that the vulnerable copy is one of two — collapsing to the first would
    // claim the wrong version is installed.
    it('joins every distinct resolved version', function () {
        const versions = new Map([
            ['node_modules/lodash', '4.17.11'],
            ['node_modules/a/node_modules/lodash', '3.10.1']
        ])
        const result = pickInstalledVersion(vuln({ nodes: ['node_modules/lodash', 'node_modules/a/node_modules/lodash'] }), versions)
        expect(result).toBe('4.17.11, 3.10.1')
    })

    it('deduplicates identical versions at different depths', function () {
        const versions = new Map([
            ['node_modules/lodash', '4.17.11'],
            ['node_modules/a/node_modules/lodash', '4.17.11']
        ])
        expect(pickInstalledVersion(vuln({ nodes: ['node_modules/lodash', 'node_modules/a/node_modules/lodash'] }), versions)).toBe('4.17.11')
    })

    it('ignores a node with no entry in the lockfile snapshot', function () {
        const versions = new Map([['node_modules/lodash', '4.17.11']])
        expect(pickInstalledVersion(vuln({ nodes: ['node_modules/absent', 'node_modules/lodash'] }), versions)).toBe('4.17.11')
    })
})

describe('normalizeAuditOutput — the fix-availability edge', function () {
    function auditWithFix(fixAvailable: unknown, range: string): ModernAudit {
        return {
            vulnerabilities: {
                lodash: {
                    name: 'lodash',
                    severity: 'high',
                    isDirect: true,
                    via: [{ source: 1234, name: 'lodash', title: 'Prototype pollution', url: 'https://example.test/1234', severity: 'high', range }],
                    effects: [],
                    range,
                    nodes: ['node_modules/lodash'],
                    fixAvailable
                }
            }
        } as unknown as ModernAudit
    }

    // npm reports fixAvailable: true with no version when the fix needs a major bump it will not pick
    // for you. Sentinello does not leave the operator with "a fix exists, somewhere" — pickSafeFixVersion
    // derives the version from the lower bound of the vulnerable range, which is the whole point of
    // version-fix.ts: "<4.17.21" means 4.17.21 is the first safe one.
    it('derives the fix version from the vulnerable range when npm names none', function () {
        const { findings } = normalizeAuditOutput(auditWithFix(true, '<4.17.21'), new Map([['node_modules/lodash', '4.17.11']]), PROD_CLASSIFIER)
        expect(findings[0]).toMatchObject({ fixAvailable: true, fixVersion: '4.17.21' })
    })

    // When the range is open-ended nothing can be derived, and this is the arm that matters: npm said
    // a fix exists, so the finding must still SAY a fix exists even though it cannot name it.
    // Reporting fixAvailable: false here would tell the operator to stop looking.
    it('keeps fixAvailable true when no version can be derived either', function () {
        const { findings } = normalizeAuditOutput(auditWithFix(true, '*'), new Map([['node_modules/lodash', '4.17.11']]), PROD_CLASSIFIER)
        expect(findings[0]).toMatchObject({ fixAvailable: true, fixVersion: null })
    })

    it('reports no fix when npm says there is none and none can be derived', function () {
        const { findings } = normalizeAuditOutput(auditWithFix(false, '*'), new Map([['node_modules/lodash', '4.17.11']]), PROD_CLASSIFIER)
        expect(findings[0]).toMatchObject({ fixAvailable: false, fixVersion: null })
    })

    it('reads a version out of the object form', function () {
        const parsed = {
            vulnerabilities: {
                lodash: {
                    name: 'lodash',
                    severity: 'high',
                    isDirect: true,
                    via: [{ source: 1234, name: 'lodash', title: 'x', url: 'https://example.test/1', severity: 'high', range: '<4.17.21' }],
                    effects: [],
                    range: '<4.17.21',
                    nodes: ['node_modules/lodash'],
                    fixAvailable: { name: 'lodash', version: '4.17.21', isSemVerMajor: false }
                }
            }
        } as unknown as ModernAudit

        const { findings } = normalizeAuditOutput(parsed, new Map([['node_modules/lodash', '4.17.11']]), PROD_CLASSIFIER)

        expect(findings[0]).toMatchObject({ fixAvailable: true, fixVersion: '4.17.21' })
    })

    it('handles an audit document with no vulnerabilities key at all', function () {
        const { findings, hadVulnerabilityWithoutConcreteAdvisory } = normalizeAuditOutput({} as ModernAudit, new Map(), PROD_CLASSIFIER)
        expect(findings).toEqual([])
        expect(hadVulnerabilityWithoutConcreteAdvisory).toBe(false)
    })
})

describe('normalizePnpmAuditOutput — the remaining arms', function () {
    function pnpmDoc(advisories: Record<string, unknown>): PnpmAudit {
        return { actions: [], advisories } as unknown as PnpmAudit
    }

    // pnpm reports the dep path as a '>'-joined string; each finding can carry several.
    it('splits every dep path and emits one finding per path', function () {
        const doc = pnpmDoc({
            1234: {
                id: 1234,
                module_name: 'lodash',
                severity: 'high',
                title: 'Prototype pollution',
                url: 'https://example.test/1234',
                vulnerable_versions: '<4.17.21',
                patched_versions: '>=4.17.21',
                findings: [{ version: '4.17.11', paths: ['app>lodash', 'app>tool>lodash'] }]
            }
        })

        const out = normalizePnpmAuditOutput(doc, PROD_CLASSIFIER)

        expect(out).toHaveLength(2)
        expect(out.map(function p(f) { return f.depPath })).toEqual([['app', 'lodash'], ['app', 'tool', 'lodash']])
    })

    // A finding with no paths still has to be reported — the advisory is real, only its provenance
    // is missing, and dropping it would silently lose a vulnerability.
    it('emits a finding with an empty dep path when pnpm supplies none', function () {
        const doc = pnpmDoc({
            1234: {
                id: 1234,
                module_name: 'lodash',
                severity: 'high',
                title: 'x',
                url: 'https://example.test/1234',
                vulnerable_versions: '<4.17.21',
                findings: [{ version: '4.17.11', paths: [] }]
            }
        })

        const out = normalizePnpmAuditOutput(doc, PROD_CLASSIFIER)

        expect(out).toHaveLength(1)
        expect(out[0]?.depPath).toEqual([])
    })

    it('defaults a missing severity to info rather than dropping the advisory', function () {
        const doc = pnpmDoc({
            1234: {
                id: 1234,
                module_name: 'lodash',
                title: 'x',
                url: 'https://example.test/1234',
                vulnerable_versions: '<4.17.21',
                findings: [{ version: '4.17.11', paths: ['lodash'] }]
            }
        })
        expect(normalizePnpmAuditOutput(doc, PROD_CLASSIFIER)[0]?.severity).toBe('info')
    })

    it('skips a null advisory entry', function () {
        const doc = pnpmDoc({ 1234: null })
        expect(normalizePnpmAuditOutput(doc, PROD_CLASSIFIER)).toEqual([])
    })

    it('handles a finding with no version', function () {
        const doc = pnpmDoc({
            1234: {
                id: 1234,
                module_name: 'lodash',
                severity: 'high',
                title: 'x',
                url: 'https://example.test/1234',
                vulnerable_versions: '<4.17.21',
                findings: [{ paths: ['lodash'] }]
            }
        })
        expect(normalizePnpmAuditOutput(doc, PROD_CLASSIFIER)[0]?.installedVersion).toBe('')
    })
})

describe('looksLikeLegacyShape — the rejections', function () {
    // Only a document that genuinely matches the npm 6 schema counts. A false positive here turns a
    // perfectly good modern audit into legacy_npm6_format and reports nothing.
    it.each([
        ['unparseable text', '{not json'],
        ['an empty string', ''],
        ['a modern document', JSON.stringify({ vulnerabilities: {} })],
        ['an unrelated object', JSON.stringify({ hello: 'world' })]
    ])('rejects %s', function (_label, text) {
        expect(looksLikeLegacyShape(text as string)).toBe(false)
    })
})

describe('classifyNvmWrapperFailure — the reordered nvm.sh spelling', function () {
    // The first rule matches "nvm.sh: ... no such file" in that order. Some shells put the reason
    // first, so a second rule matches the two halves independently. Without it, that spelling falls
    // through to a generic unknown failure carrying raw bash output.
    it('classifies a reason-first nvm.sh miss', function () {
        expect(classifyNvmWrapperFailure('No such file or directory - /home/app/.nvm/nvm.sh'))
            .toMatchObject({ kind: 'unauditable', reasonCode: 'nvm_missing' })
    })
})

describe('normalizeAuditOutput — an entry with no usable advisory id', function () {
    // via holds an object, so it is not the "indirect string" case, but every field a caller could
    // key on is absent. Skipping it is correct — a finding with no id cannot be deduped, muted or
    // linked — but the document as a whole must still yield its other findings.
    it('skips the unidentifiable entry and keeps the rest', function () {
        const parsed = {
            vulnerabilities: {
                lodash: {
                    name: 'lodash',
                    severity: 'high',
                    isDirect: true,
                    via: [{ name: 'lodash', range: '<4.17.21' }],
                    effects: [],
                    range: '<4.17.21',
                    nodes: ['node_modules/lodash'],
                    fixAvailable: false
                },
                express: {
                    name: 'express',
                    severity: 'high',
                    isDirect: true,
                    via: [{ source: 5678, name: 'express', title: 'x', url: 'https://example.test/5678', severity: 'high', range: '<4.18.0' }],
                    effects: [],
                    range: '<4.18.0',
                    nodes: ['node_modules/express'],
                    fixAvailable: false
                }
            }
        } as unknown as ModernAudit

        const { findings } = normalizeAuditOutput(parsed, new Map(), PROD_CLASSIFIER)

        expect(findings.map(function name(f) { return f.packageName })).toEqual(['express'])
    })
})
