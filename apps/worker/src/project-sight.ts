import { dirname, join, resolve } from 'node:path'
import { installedThrough, type FindingInstallation, type Project, type ProjectManifest } from '@sentinello/core'
import { isExcludedPath, isWithin, rediscoverProject } from '@sentinello/scanners'

// What the disk says of a project against what a scan reads there, by comparing two walks: one past its ignore files,
// and one as a scan walks it. Only the directories no scan ever searches stay unseen by both, and no row came from those.
export type ProjectSight = {
    // Whether both walks still find the project.
    found: boolean
    // What the project owns on the disk, and which of those a scan's walk does not reach.
    manifests: readonly ProjectManifest[]
    hidden: readonly ProjectManifest[]
    // The directories either walk could not read.
    unreadable: readonly string[]
}

export function readProjectSight(rootPath: string, relPath: string, excludes: readonly string[]): ProjectSight {
    const projectPath = join(rootPath, relPath)
    const onDisk = rediscoverProject({ rootPath, projectPath, readIgnoreFiles: false })
    const scanned = rediscoverProject({ rootPath, projectPath, excludes: [...excludes] })
    const seen = new Set(scanned.project?.manifests.map(function path(manifest) { return manifest.path }))
    const manifests = onDisk.project?.manifests ?? []
    return {
        found: onDisk.project !== null && scanned.project !== null,
        manifests,
        hidden: manifests.filter(function unseen(manifest) { return !seen.has(manifest.path) }),
        unreadable: [...onDisk.errors, ...scanned.errors].map(function directory(error) { return resolve(error.path) })
    }
}

// Whether a named copy may still be where a scan does not look. Only its own place counts, so a hidden manifest elsewhere
// holds nothing back: a copy belongs to its directory's manifest of the ecosystem (installedThrough), and with none left
// there, the copy is gone. A directory that cannot be read, at or above the copy, proves nothing.
export function hidesCopy(sight: ProjectSight, rootPath: string, relPath: string, installation: FindingInstallation, ecosystem: string): boolean {
    return inPlace(sight.hidden, sight, rootPath, relPath, installation, ecosystem)
}

// The same question for a copy an exclusion covers, against everything on the disk: the walk skips directories only, so a
// rule naming the file leaves the manifest out of `hidden` while it is still the operator's to leave unread.
export function excludedCopyPresent(sight: ProjectSight, rootPath: string, relPath: string, installation: FindingInstallation, ecosystem: string): boolean {
    return inPlace(sight.manifests, sight, rootPath, relPath, installation, ecosystem)
}

function inPlace(manifests: readonly ProjectManifest[], sight: ProjectSight, rootPath: string, relPath: string, installation: FindingInstallation, ecosystem: string): boolean {
    const manifestDir = dirname(resolve(rootPath, relPath, installation.manifestPath))
    if (sight.unreadable.some(function above(directory) { return isWithin(directory, manifestDir) })) return true
    const sameEcosystem = manifests.filter(function ofEcosystem(manifest) { return manifest.ecosystem === ecosystem })
    return installedThrough(installation, sameEcosystem.map(function path(manifest) { return manifest.path }))
}

// Which of the project's known copies a scan will not reach and may still be there, by ecosystem, for the merge to carry
// on the rows that go on (SENTINEL-200). A copy the inventory holds a manifest for is the scan's to read or to report
// unread, so the disk is only walked, twice, while some open row names a copy the inventory does not hold. A copy an
// exclusion covers is left out: the operator's rule narrows the row (SENTINEL-172).
export function copiesOutOfSight(
    project: Pick<Project, 'relPath' | 'manifests'>,
    rootPath: string,
    excludes: readonly string[],
    openCopies: readonly { ecosystem: string; installations: readonly FindingInstallation[] }[]
): Map<string, string[]> {
    const out = new Map<string, string[]>()
    const unknown = openCopies.flatMap(function missing({ ecosystem, installations }) {
        const inventory = project.manifests.filter(function ofEcosystem(manifest) { return manifest.ecosystem === ecosystem }).map(function path(manifest) { return manifest.path })
        return installations.filter(function notHeld(installation) { return !installedThrough(installation, inventory) }).map(function withEcosystem(installation) { return { ecosystem, installation } })
    })
    if (unknown.length === 0) return out
    const sight = readProjectSight(rootPath, project.relPath, excludes)
    for (const { ecosystem, installation } of unknown) {
        if (isExcludedPath(rootPath, join(rootPath, project.relPath, installation.manifestPath), excludes)) continue
        if (!hidesCopy(sight, rootPath, project.relPath, installation, ecosystem)) continue
        out.set(ecosystem, [...(out.get(ecosystem) ?? []), installation.manifestPath])
    }
    return out
}
