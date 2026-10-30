'use server'

import { revalidatePath } from 'next/cache'
import { ulid } from 'ulid'
import { deleteMute, insertMute, listActiveMutes } from '@sentinello/db'
import { requireEcosystemId, type MuteScope, type MuteWrite } from '@sentinello/core'
import { getDb } from '@/lib/db'
import { libraryHref } from '@/lib/library-href'

export type MuteFormInput = {
    scope: MuteScope
    projectId: string | null
    // The finding's persisted source identity (finding.source), written into the back-compat
    // mutes.scanner column — NOT the plugin/provenance scanner name. See issue-016.
    source: string | null
    // EcosystemId of the muted finding: required for finding scope, so an npm mute never silences the PyPI
    // package of the same name and nothing guesses npm for it (SENTINEL-121).
    ecosystem?: string | null
    advisoryId: string | null
    packageName: string | null
    reason: string
    expiresAt: number | null
}

export async function muteAction(input: MuteFormInput): Promise<void> {
    if (input.scope === 'finding') {
        if (!input.source || !input.ecosystem || !input.advisoryId || !input.packageName) {
            throw new Error('finding-scope mutes require source, ecosystem, advisoryId, and packageName')
        }
    }
    if (input.reason.trim().length === 0) {
        throw new Error('mute reason is required')
    }
    const db = getDb()
    const author = process.env.ME_NAME || 'anonymous'
    const common = { id: ulid(), reason: input.reason.trim(), author, createdAt: Date.now(), expiresAt: input.expiresAt }
    const mute: MuteWrite = input.scope === 'project'
        ? { ...common, scope: 'project', projectId: requireProjectId(input.projectId) }
        : {
            ...common,
            scope: 'finding',
            projectId: input.projectId,
            scanner: input.source as string,
            ecosystem: requireEcosystemId(input.ecosystem as string),
            advisoryId: input.advisoryId as string,
            packageName: input.packageName as string
        }
    insertMute(db, mute)
    if (input.projectId) revalidatePath('/projects/' + input.projectId)
    revalidatePath('/projects')
    revalidatePath('/')
}

// A project mute applies to one project; one without a project would silence nothing in particular.
function requireProjectId(projectId: string | null): string {
    if (!projectId) throw new Error('project-scope mutes require a projectId')
    return projectId
}

export type MuteLibraryAdvisory = {
    // Persisted source identity (finding.source), written into mutes.scanner — not the plugin name.
    source: string
    ecosystem: string
    advisoryId: string
}

export type MuteLibraryInput = {
    projectId: string
    packageName: string
    advisories: MuteLibraryAdvisory[]
    reason: string
    expiresAt: number | null
}

// Mutes every advisory listed on a single package for a single project. Skips advisories that
// already have an active matching mute so re-submitting the dialog is idempotent. Revalidates
// once at the end instead of per insert.
export async function muteLibraryAction(input: MuteLibraryInput): Promise<{ created: number; skipped: number }> {
    if (input.reason.trim().length === 0) {
        throw new Error('mute reason is required')
    }
    if (input.advisories.length === 0) {
        return { created: 0, skipped: 0 }
    }
    const db = getDb()
    const now = Date.now()
    const author = process.env.ME_NAME || 'anonymous'
    const reason = input.reason.trim()
    const active = listActiveMutes(db, now)
    let created = 0
    let skipped = 0
    for (const adv of input.advisories) {
        const alreadyMuted = active.some(function matches(m): boolean {
            if (m.scope === 'project') return m.projectId === input.projectId
            return (
                m.scope === 'finding' &&
                (m.projectId === null || m.projectId === input.projectId) &&
                m.scanner === adv.source &&
                (m.ecosystem === null || m.ecosystem === adv.ecosystem) &&
                m.advisoryId === adv.advisoryId &&
                m.packageName === input.packageName
            )
        })
        if (alreadyMuted) {
            skipped += 1
            continue
        }
        const mute: MuteWrite = {
            id: ulid(),
            scope: 'finding',
            projectId: input.projectId,
            scanner: adv.source,
            ecosystem: requireEcosystemId(adv.ecosystem),
            advisoryId: adv.advisoryId,
            packageName: input.packageName,
            reason,
            author,
            createdAt: now,
            expiresAt: input.expiresAt
        }
        insertMute(db, mute)
        created += 1
    }
    revalidatePath('/projects/' + input.projectId)
    revalidatePath('/projects')
    revalidatePath('/')
    return { created, skipped }
}

export type MuteLibraryEverywhereRow = {
    projectId: string
    // Persisted source identity (finding.source), written into mutes.scanner — not the plugin name.
    source: string
    ecosystem: string
    advisoryId: string
}

export type MuteLibraryEverywhereInput = {
    packageName: string
    rows: MuteLibraryEverywhereRow[]
    reason: string
    expiresAt: number | null
}

// Mutes a library across every project currently affected by it in a single transaction-like batch.
// Skips rows already covered by an active matching mute so re-submitting the dialog is idempotent.
// Each row produces its own finding-scope mute scoped to that project (not a global null-project
// mute) so per-project unmutes from the project page still work the same way.
export async function muteLibraryEverywhereAction(
    input: MuteLibraryEverywhereInput
): Promise<{ created: number; skipped: number }> {
    if (input.reason.trim().length === 0) {
        throw new Error('mute reason is required')
    }
    if (input.rows.length === 0) {
        return { created: 0, skipped: 0 }
    }
    const db = getDb()
    const now = Date.now()
    const author = process.env.ME_NAME || 'anonymous'
    const reason = input.reason.trim()
    const active = listActiveMutes(db, now)
    const affectedProjects = new Set<string>()
    let created = 0
    let skipped = 0
    for (const row of input.rows) {
        const alreadyMuted = active.some(function matches(m): boolean {
            if (m.scope === 'project') return m.projectId === row.projectId
            return (
                m.scope === 'finding' &&
                (m.projectId === null || m.projectId === row.projectId) &&
                m.scanner === row.source &&
                (m.ecosystem === null || m.ecosystem === row.ecosystem) &&
                m.advisoryId === row.advisoryId &&
                m.packageName === input.packageName
            )
        })
        if (alreadyMuted) {
            skipped += 1
            continue
        }
        const mute: MuteWrite = {
            id: ulid(),
            scope: 'finding',
            projectId: row.projectId,
            scanner: row.source,
            ecosystem: requireEcosystemId(row.ecosystem),
            advisoryId: row.advisoryId,
            packageName: input.packageName,
            reason,
            author,
            createdAt: now,
            expiresAt: input.expiresAt
        }
        insertMute(db, mute)
        affectedProjects.add(row.projectId)
        created += 1
    }
    // Bust the detail page for each (ecosystem, packageName) cell touched — a library URL now encodes
    // both segments, so revalidating a bare package path would miss the page actually being viewed.
    const bustedEcosystems = new Set<string>()
    for (const row of input.rows) {
        const eco = row.ecosystem
        if (bustedEcosystems.has(eco)) continue
        bustedEcosystems.add(eco)
        revalidatePath(libraryHref(eco, input.packageName))
    }
    revalidatePath('/libraries')
    revalidatePath('/projects')
    revalidatePath('/')
    affectedProjects.forEach(function bust(projectId) {
        revalidatePath('/projects/' + projectId)
    })
    return { created, skipped }
}

export async function unmuteAction(muteId: string, projectId: string | null): Promise<void> {
    const db = getDb()
    deleteMute(db, muteId)
    if (projectId) revalidatePath('/projects/' + projectId)
    revalidatePath('/projects')
    revalidatePath('/')
}

// Lifts several mutes at once — used to unmute a merged finding row, which stands in for one mute per
// underlying (scanner, advisoryId) identity. Revalidates once at the end instead of per delete.
export async function unmuteManyAction(muteIds: string[], projectId: string | null): Promise<void> {
    if (muteIds.length === 0) return
    const db = getDb()
    for (const id of muteIds) deleteMute(db, id)
    if (projectId) revalidatePath('/projects/' + projectId)
    revalidatePath('/projects')
    revalidatePath('/')
}
