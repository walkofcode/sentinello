'use server'

import { revalidatePath } from 'next/cache'
import {
    enqueueScanRequest,
    getProjectById,
    isAnyScanInFlight,
    isScanInFlightForProject,
    isScanInFlightForRoot
} from '@sentinello/db'
import { getDb } from '@/lib/db'

export async function requestScanForProject(projectId: string): Promise<void> {
    const db = getDb()
    const project = getProjectById(db, projectId)
    if (!project) return
    // Dedupe: if a covering scan (this project, its root, or full sweep) is already in flight,
    // do not enqueue another. UI button is already disabled in this state — this is a race guard.
    if (isScanInFlightForProject(db, projectId, project.rootId, Date.now())) return
    enqueueScanRequest(db, { projectId }, Date.now())
    revalidatePath('/projects/' + projectId)
    revalidatePath('/projects')
}

export async function requestScanForRoot(rootId: string): Promise<void> {
    const db = getDb()
    if (isScanInFlightForRoot(db, rootId, Date.now())) return
    enqueueScanRequest(db, { rootId }, Date.now())
    revalidatePath('/settings/roots')
    revalidatePath('/projects')
}

export async function requestFullSweep(): Promise<void> {
    const db = getDb()
    if (isAnyScanInFlight(db, Date.now())) return
    enqueueScanRequest(db, {}, Date.now())
    revalidatePath('/projects')
    revalidatePath('/')
}
