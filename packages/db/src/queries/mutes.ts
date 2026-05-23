import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm'
import type { Mute } from '@sentinello/core'
import type { DrizzleDb } from '../client'
import { mutes } from '../schema'

type MuteRow = typeof mutes.$inferSelect

export type MuteMatchInput = {
    projectId: string
    scanner: string
    advisoryId: string
    packageName: string
    at: number
}

export function listActiveMutes(db: DrizzleDb, at: number): Mute[] {
    const rows = db
        .select()
        .from(mutes)
        .where(or(isNull(mutes.expiresAt), gt(mutes.expiresAt, at)))
        .all()
    return rows.map(rowToMute)
}

export function listExpiredMutes(db: DrizzleDb, at: number): Mute[] {
    const rows = db.select().from(mutes).where(and(sql`${mutes.expiresAt} IS NOT NULL`, lte(mutes.expiresAt, at))).all()
    return rows.map(rowToMute)
}

// Returns true if a finding-identity is muted at time `at`.
// Project-scope: matches projectId only (applies across all scanners).
// Finding-scope: matches the full (projectId, scanner, advisoryId, packageName) tuple.
// Global finding mute (scope=finding, projectId IS NULL) matches (scanner, advisoryId, packageName)
// across any project.
export function isMuted(db: DrizzleDb, input: MuteMatchInput): boolean {
    const candidates = db
        .select()
        .from(mutes)
        .where(or(isNull(mutes.expiresAt), gt(mutes.expiresAt, input.at)))
        .all()
    return candidates.some(function matches(row): boolean {
        if (row.scope === 'project') {
            return row.projectId === input.projectId
        }
        // scope === 'finding'
        const projectMatches = row.projectId === null || row.projectId === input.projectId
        const scannerMatches = row.scanner === input.scanner
        const advisoryMatches = row.advisoryId === input.advisoryId
        const packageMatches = row.packageName === input.packageName
        return projectMatches && scannerMatches && advisoryMatches && packageMatches
    })
}

export function insertMute(db: DrizzleDb, mute: Mute): void {
    db.insert(mutes)
        .values({
            id: mute.id,
            scope: mute.scope,
            projectId: mute.projectId,
            scanner: mute.scanner,
            advisoryId: mute.advisoryId,
            packageName: mute.packageName,
            reason: mute.reason,
            author: mute.author,
            createdAt: mute.createdAt,
            expiresAt: mute.expiresAt
        })
        .run()
}

export function deleteMute(db: DrizzleDb, id: string): void {
    db.delete(mutes).where(eq(mutes.id, id)).run()
}

function rowToMute(row: MuteRow): Mute {
    return {
        id: row.id,
        scope: row.scope,
        projectId: row.projectId,
        scanner: row.scanner,
        advisoryId: row.advisoryId,
        packageName: row.packageName,
        reason: row.reason,
        author: row.author,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt
    }
}
