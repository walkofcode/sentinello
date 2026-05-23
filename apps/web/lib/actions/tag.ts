'use server'

import { revalidatePath } from 'next/cache'
import { getProjectById, setProjectTags } from '@sentinello/db'
import { getDb } from '@/lib/db'

export async function setProjectTagsAction(projectId: string, tagsCsv: string): Promise<void> {
    const db = getDb()
    const project = getProjectById(db, projectId)
    if (!project) throw new Error('project not found: ' + projectId)
    const tags = tagsCsv
        .split(',')
        .map(function trim(s) {
            return s.trim()
        })
        .filter(function nonEmpty(s) {
            return s.length > 0
        })
    setProjectTags(db, projectId, tags, Date.now())
    revalidatePath('/projects/' + projectId)
    revalidatePath('/projects')
}
