import type { DetectedLockfile } from '../types'
import { parseNpmLock } from './npm-lock'
import { parsePnpmLock } from './pnpm'
import type { ResolvedGraph } from './types'

export type { DepScope, ResolvedGraph, ResolvedPackage } from './types'

// Resolves a project's lockfile into the canonical ResolvedGraph once per scan. Every advisory source
// shares the result, so prod/dev classification is computed a single way. yarn.lock and any unparseable
// lock return null (fail-open) — callers treat that as "unauditable", same posture as before.
export async function resolveProject(
    projectPath: string,
    lockfile: DetectedLockfile
): Promise<ResolvedGraph | null> {
    if (lockfile.kind === 'package-lock.json') {
        return parseNpmLock(projectPath, lockfile.absolutePath)
    }
    if (lockfile.kind === 'pnpm-lock.yaml') {
        return parsePnpmLock(lockfile.absolutePath)
    }
    return null
}
