import { describe, expect, it } from 'vitest'
import type { ProjectManifest } from '@sentinello/core'
import { hasNodeRuntime, nodeRuntimeLabel, packageManagersLabel } from './project-toolchain'

const PNPM: ProjectManifest = { path: 'pnpm-lock.yaml', ecosystem: 'npm', kind: 'pnpm-lock.yaml' }
const GEMFILE: ProjectManifest = { path: 'ios/Gemfile.lock', ecosystem: 'RubyGems', kind: 'Gemfile.lock' }
const POETRY: ProjectManifest = { path: 'poetry.lock', ecosystem: 'PyPI', kind: 'poetry.lock' }
const BARE_PACKAGE_JSON: ProjectManifest = { path: 'package.json', ecosystem: 'npm', kind: 'package.json' }
const BARE_PYPROJECT: ProjectManifest = { path: 'pyproject.toml', ecosystem: 'PyPI', kind: 'pyproject.toml' }

describe('the PM column', function () {
    it('lists every manager the manifests name, once each', function () {
        expect(packageManagersLabel([PNPM, GEMFILE], 'pnpm')).toBe('pnpm · bundler')
        expect(packageManagersLabel([POETRY, PNPM, { ...PNPM, path: 'web/pnpm-lock.yaml' }], 'pnpm')).toBe('poetry · pnpm')
    })

    // A row discovered before 3.8 recorded no manifests: it reads as it always did.
    it('falls back to the project packageManager for a legacy row', function () {
        expect(packageManagersLabel([], 'yarn')).toBe('yarn')
    })

    // A lone package.json or pyproject.toml names no manager; that is no reason to show an empty cell.
    it('falls back to the project packageManager when no manifest names a manager', function () {
        expect(packageManagersLabel([BARE_PYPROJECT], 'unknown')).toBe('unknown')
    })
})

describe('the Runtime column', function () {
    it('shows the Node version only for a project with npm dependencies', function () {
        expect(nodeRuntimeLabel([PNPM, GEMFILE], 'pnpm', '20', 'ambient')).toBe('Node 20')
        expect(nodeRuntimeLabel([BARE_PACKAGE_JSON], 'unknown', null, 'ambient')).toBe('Node ambient')
        expect(nodeRuntimeLabel([POETRY], 'poetry', null, 'ambient')).toBeNull()
        expect(nodeRuntimeLabel([GEMFILE], 'bundler', '20', 'ambient')).toBeNull()
    })

    // Before 3.8 every project was a Node project, an 'unknown' manager included: a package.json with no
    // lockfile. A legacy row with any other manager has no Node to speak of.
    it('reads a legacy row by its packageManager', function () {
        expect(hasNodeRuntime([], 'npm')).toBe(true)
        expect(hasNodeRuntime([], 'yarn')).toBe(true)
        expect(hasNodeRuntime([], 'pnpm')).toBe(true)
        expect(hasNodeRuntime([], 'unknown')).toBe(true)
        expect(hasNodeRuntime([], 'poetry')).toBe(false)
        expect(nodeRuntimeLabel([], 'npm', null, 'ambiente')).toBe('Node ambiente')
    })
})
