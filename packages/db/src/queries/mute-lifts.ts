import { and, desc, eq, isNull, or } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DrizzleDb } from '../client'
import { muteLifts } from '../schema'
import type { Mute } from '@sentinello/core'

export type MuteLift = {
    id: string
    muteId: string
    liftedAt: number
    scope: 'project' | 'finding'
    projectId: string | null
    scanner: string | null
    ecosystem: string | null
    advisoryId: string | null
    packageName: string | null
    reason: string
    author: string
}

type MuteLiftRow = typeof muteLifts.$inferSelect

export function recordMuteLift(db: DrizzleDb, mute: Mute, at: number): MuteLift {
    const row = {
        id: ulid(),
        muteId: mute.id,
        liftedAt: at,
        scope: mute.scope,
        projectId: mute.projectId,
        scanner: mute.scanner,
        ecosystem: mute.ecosystem,
        advisoryId: mute.advisoryId,
        packageName: mute.packageName,
        reason: mute.reason,
        author: mute.author
    }
    db.insert(muteLifts).values(row).run()
    return row
}

export function listMuteLiftsForProject(db: DrizzleDb, projectId: string, limit = 50): MuteLift[] {
    const rows = db
        .select()
        .from(muteLifts)
        .where(eq(muteLifts.projectId, projectId))
        .orderBy(desc(muteLifts.liftedAt))
        .limit(limit)
        .all()
    return rows.map(rowToLift)
}

export function listMuteLiftsForLibrary(
    db: DrizzleDb,
    packageName: string,
    limit = 50,
    ecosystem?: string
): MuteLift[] {
    // A NULL ecosystem on a lift is a legacy (pre-polyglot) row that matches any ecosystem; once
    // backfilled to 'npm' it matches only its own ecosystem, so a same-named package in another
    // ecosystem never shows up in this library's history.
    const where = ecosystem
        ? and(
              eq(muteLifts.packageName, packageName),
              or(isNull(muteLifts.ecosystem), eq(muteLifts.ecosystem, ecosystem))
          )
        : eq(muteLifts.packageName, packageName)
    const rows = db
        .select()
        .from(muteLifts)
        .where(where)
        .orderBy(desc(muteLifts.liftedAt))
        .limit(limit)
        .all()
    return rows.map(rowToLift)
}

export function listRecentMuteLifts(db: DrizzleDb, limit = 50): MuteLift[] {
    const rows = db.select().from(muteLifts).orderBy(desc(muteLifts.liftedAt)).limit(limit).all()
    return rows.map(rowToLift)
}

function rowToLift(row: MuteLiftRow): MuteLift {
    return {
        id: row.id,
        muteId: row.muteId,
        liftedAt: row.liftedAt,
        scope: row.scope,
        projectId: row.projectId,
        scanner: row.scanner,
        ecosystem: row.ecosystem,
        advisoryId: row.advisoryId,
        packageName: row.packageName,
        reason: row.reason,
        author: row.author
    }
}
