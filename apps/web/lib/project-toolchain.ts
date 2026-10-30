import { projectPackageManagers, type ProjectManifest } from '@sentinello/core'

// What the project card and the project page say about a project's toolchain: the "PM" and "Runtime"
// columns. Kept out of the .tsx so the fallbacks for a row discovered before 3.8 are pinned by a test.

// The managers a legacy row's single packageManager meant a Node project for. Before 3.8 every project was
// one, and 'unknown' was a package.json with no lockfile.
const LEGACY_NODE_MANAGERS = ['npm', 'yarn', 'pnpm', 'unknown']

// The PM column: every manager the project's manifests name, `pnpm · bundler`. A row discovered before 3.8
// recorded no manifests and keeps the one packageManager it was discovered with, as do manifests that name
// no manager at all (a lone package.json or pyproject.toml).
export function packageManagersLabel(manifests: readonly ProjectManifest[], packageManager: string): string {
    const managers = projectPackageManagers(manifests)
    if (managers.length === 0) return packageManager
    return managers.join(' · ')
}

// Whether a Node version means anything for the project: it has an npm manifest, or it is a legacy row
// whose packageManager was a Node one.
export function hasNodeRuntime(manifests: readonly ProjectManifest[], packageManager: string): boolean {
    if (manifests.length === 0) return LEGACY_NODE_MANAGERS.includes(packageManager)
    return manifests.some(function npm(manifest) { return manifest.ecosystem === 'npm' })
}

// The Runtime column: `Node 20` from the project's .nvmrc, `Node <ambient>` without one, and null for a
// project with no Node dependencies, where a Node version would be noise. `ambient` is the reader-locale
// word for the Node on the worker's PATH.
export function nodeRuntimeLabel(manifests: readonly ProjectManifest[], packageManager: string, nvmrcVersion: string | null, ambient: string): string | null {
    if (!hasNodeRuntime(manifests, packageManager)) return null
    return 'Node ' + (nvmrcVersion || ambient)
}
