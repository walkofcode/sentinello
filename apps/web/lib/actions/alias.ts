'use server'

import { revalidatePath } from 'next/cache'
import { getProjectById, setProjectAlias } from '@sentinello/db'
import { getDb } from '@/lib/db'

export async function setProjectAliasAction(projectId: string, alias: string): Promise<void> {
    const db = getDb()
    const project = getProjectById(db, projectId)
    if (!project) throw new Error('project not found: ' + projectId)
    const trimmed = alias.trim()
    setProjectAlias(db, projectId, trimmed.length > 0 ? trimmed : null, Date.now())
    revalidatePath('/projects/' + projectId)
    revalidatePath('/')
}
