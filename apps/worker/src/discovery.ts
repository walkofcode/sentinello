import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Project, type ProjectManifest } from '@sentinello/core'
import { discoverProjectsInTree, readGitBranch, rediscoverProject, withUnreadManifests, type DiscoveredProject, type DiscoveryError, type DiscoverySkip } from '@sentinello/scanners'
import {
    type DrizzleDb,
    type Root,
    listProjects,
    deleteProject,
    upsertProject,
    setProjectInventory,
    projectId as makeProjectId
} from '@sentinello/db'

// The worker's discovery pass: walk every mounted root and reconcile what was found against the database.
// The walk itself — including all ignore-rule handling — lives in @sentinello/scanners so the CLI performs
// discovery identically; this module owns only the parts that need a database.

export { readGitBranch }

export type DiscoveryInput = {
    db: DrizzleDb
    roots: Root[]
    globalIgnore: string[]
    at: number
}

export type DiscoveryResult = {
    discoveredProjects: Project[]
    newProjectIds: string[]
    deletedProjectIds: string[]
}

export function discoverProjects(input: DiscoveryInput): DiscoveryResult {
    const discoveredByPath = new Map<string, Project>()
    // Recorded inside the loop, immediately past the existsSync guard, so it holds the roots actually
    // walked rather than the roots requested. Deriving it from input.roots instead would reconcile an
    // unmounted root against an empty walk and hard-delete every project under it; re-checking
    // existsSync further down would reintroduce that on a mount that drops mid-pass.
    const walkedRootIds = new Set<string>()
    // Roots whose walk could not read some directory. Their result is incomplete, so a project missing from
    // it may still be on disk: those roots get their discoveries recorded but nothing deleted, and a project
    // found keeps its recorded manifests below the unreadable directories (withUnreadManifests).
    const incompleteRootIds = new Set<string>()
    const recordedById = new Map(listProjects(input.db).map(function pair(p): [string, Project] {
        return [p.id, p]
    }))
    for (const root of input.roots) {
        if (!existsSync(root.path)) continue
        walkedRootIds.add(root.id)
        const errors: DiscoveryError[] = []
        const found = discoverProjectsInTree({
            rootPath: root.path,
            excludes: input.globalIgnore,
            onSkip: logSkip,
            onError: function record(error) {
                errors.push(error)
            }
        })
        if (errors.length > 0) {
            incompleteRootIds.add(root.id)
            logIncompleteWalk(root.path, errors)
        }
        for (const walked of found) {
            const id = makeProjectId(root.id, walked.relPath)
            const recorded = recordedById.get(id)
            const project = recorded ? withUnreadManifests(walked, recorded.manifests, errors) : walked
            discoveredByPath.set(project.absolutePath, {
                id,
                rootId: root.id,
                relPath: project.relPath,
                name: project.name,
                alias: null,
                packageManager: project.packageManager,
                nvmrcVersion: project.nvmrcVersion,
                gitBranch: project.gitBranch,
                ecosystems: project.ecosystems,
                manifests: project.manifests,
                muted: false,
                tags: [],
                createdAt: input.at,
                updatedAt: input.at
            })
        }
    }
    // Reconciliation is scoped to the roots we actually walked. Otherwise a per-root sweep would
    // mark every project under unrelated roots as "missing" just because we didn't visit them.
    const existing = Array.from(recordedById.values()).filter(function inScope(p): boolean {
        return walkedRootIds.has(p.rootId)
    })
    const existingById = new Map(existing.map(function pair(p): [string, Project] {
        return [p.id, p]
    }))
    const discovered = Array.from(discoveredByPath.values())
    const newProjectIds: string[] = []
    for (const project of discovered) {
        const prior = existingById.get(project.id)
        if (!prior) {
            upsertProject(input.db, project)
            newProjectIds.push(project.id)
            continue
        }
        // Preserve user-controlled fields (muted, tags, alias) and createdAt.
        const merged: Project = {
            ...project,
            alias: prior.alias,
            muted: prior.muted,
            tags: prior.tags,
            createdAt: prior.createdAt
        }
        upsertProject(input.db, merged)
    }
    const discoveredIds = new Set(discovered.map(function id(p): string {
        return p.id
    }))
    const deletedProjectIds: string[] = []
    for (const prior of existing) {
        if (discoveredIds.has(prior.id)) continue
        if (incompleteRootIds.has(prior.rootId)) continue
        // The project's root was walked but the folder is gone, so the project is genuinely gone.
        // Sentinello keeps only what it currently sees: hard-delete the project and all of its
        // history (scans, findings, notification events/deliveries, mutes). An unmounted root never
        // reaches here — it is skipped above and excluded from `existing`, so its projects survive.
        deleteProject(input.db, prior.id)
        deletedProjectIds.push(prior.id)
    }
    return { discoveredProjects: discovered, newProjectIds, deletedProjectIds }
}

// Re-reads one project's directory at scan start (rediscoverProject) and records what changed since the last
// sweep, so a single-project scan — the watcher's, a manual one — scans the manifests the project holds now:
// a uv.lock added beside a bare pyproject.toml, an ios/Gemfile.lock added to an npm project. Mutates the
// in-memory project the scan goes on to use. A directory that no longer anchors a project keeps its recorded
// inventory: whether the project is gone is the next discovery pass's call, and its scan then says what it
// could not read.
export function refreshProjectInventory(db: DrizzleDb, project: Project, rootPath: string, globalIgnore: string[], at: number): void {
    const projectPath = resolve(rootPath, project.relPath)
    const rediscovery = rediscoverProject({ rootPath, projectPath, excludes: globalIgnore })
    if (rediscovery.project === null) return
    for (const error of rediscovery.errors) console.log('[discovery] could not read ' + error.path + ': ' + error.message)
    const now = withUnreadManifests(rediscovery.project, project.manifests, rediscovery.errors)
    if (sameInventory(project, now)) return
    project.packageManager = now.packageManager
    project.nvmrcVersion = now.nvmrcVersion
    project.ecosystems = now.ecosystems
    project.manifests = now.manifests
    setProjectInventory(db, project.id, project, at)
}

function sameInventory(project: Project, now: DiscoveredProject): boolean {
    return project.packageManager === now.packageManager
        && project.nvmrcVersion === now.nvmrcVersion
        && project.ecosystems.join(',') === now.ecosystems.join(',')
        && manifestKeys(project.manifests) === manifestKeys(now.manifests)
}

function manifestKeys(manifests: readonly ProjectManifest[]): string {
    return manifests.map(function key(m) { return m.path + '|' + m.ecosystem + '|' + m.kind }).join(',')
}

// A directory that went unreadable mid-walk (a permissions change, a mount dropping under the walk) used to
// read as empty, and every project below it was hard-deleted with its history. Saying why the deletes were
// held back is what lets an operator tell a held-back sweep from a project that genuinely survived.
function logIncompleteWalk(rootPath: string, errors: DiscoveryError[]): void {
    for (const error of errors) {
        console.log('[discovery] could not read ' + error.path + ': ' + error.message)
    }
    console.log('[discovery] not deleting any project under ' + rootPath + ' this pass: ' + errors.length + ' unreadable path(s) left the walk incomplete')
}

// Discovery now honours .gitignore, so a directory an operator expected to see can legitimately be
// skipped. Logging every skip with the rule source is what turns "my project vanished from the
// dashboard" into a one-line answer — including which .sentinelloignore negation would bring it back.
function logSkip(skip: DiscoverySkip): void {
    console.log('[discovery] skipped ' + skip.path + ' (' + skip.source + ')')
}
