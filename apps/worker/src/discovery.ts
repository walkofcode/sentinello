import { existsSync } from 'node:fs'
import { type Project } from '@sentinello/core'
import { discoverProjectsInTree, readGitBranch, type DiscoverySkip } from '@sentinello/scanners'
import {
    type DrizzleDb,
    type Root,
    listProjects,
    deleteProject,
    upsertProject,
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
    for (const root of input.roots) {
        if (!existsSync(root.path)) continue
        walkedRootIds.add(root.id)
        const found = discoverProjectsInTree({
            rootPath: root.path,
            excludes: input.globalIgnore,
            onSkip: logSkip
        })
        for (const project of found) {
            discoveredByPath.set(project.absolutePath, {
                id: makeProjectId(root.id, project.relPath),
                rootId: root.id,
                relPath: project.relPath,
                name: project.name,
                alias: null,
                packageManager: project.packageManager,
                nvmrcVersion: project.nvmrcVersion,
                gitBranch: project.gitBranch,
                ecosystems: project.ecosystems,
                muted: false,
                tags: [],
                createdAt: input.at,
                updatedAt: input.at
            })
        }
    }
    // Reconciliation is scoped to the roots we actually walked. Otherwise a per-root sweep would
    // mark every project under unrelated roots as "missing" just because we didn't visit them.
    const existing = listProjects(input.db).filter(function inScope(p): boolean {
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
        // The project's root was walked but the folder is gone, so the project is genuinely gone.
        // Sentinello keeps only what it currently sees: hard-delete the project and all of its
        // history (scans, findings, notification events/deliveries, mutes). An unmounted root never
        // reaches here — it is skipped above and excluded from `existing`, so its projects survive.
        deleteProject(input.db, prior.id)
        deletedProjectIds.push(prior.id)
    }
    return { discoveredProjects: discovered, newProjectIds, deletedProjectIds }
}

// Discovery now honours .gitignore, so a directory an operator expected to see can legitimately be
// skipped. Logging every skip with the rule source is what turns "my project vanished from the
// dashboard" into a one-line answer — including which .sentinelloignore negation would bring it back.
function logSkip(skip: DiscoverySkip): void {
    console.log('[discovery] skipped ' + skip.path + ' (' + skip.source + ')')
}
