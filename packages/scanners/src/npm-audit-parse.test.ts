import { describe, expect, it } from 'vitest'
import {
    buildBashWrappedCommand,
    classifyNvmWrapperFailure,
    classifyPackageManagerNotFound,
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

    it('tolerates leading whitespace', function () {
        expect(looksLikeLegacyShape('\n  ' + JSON.stringify({ advisories: {} }))).toBe(true)
    })
})
