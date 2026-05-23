import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import {
    deleteRoot,
    getRootByPath,
    listRoots,
    setConfigValue,
    upsertRoot,
    type DrizzleDb,
    type Root
} from '@sentinello/db'
import { rootId } from '@sentinello/db'

// Static disk reads of sentinello.config.{json,yaml} are intentionally synchronous (no async/await).
// Parsed synchronously once at worker boot.

const rootConfigSchema = z.object({
    path: z.string().min(1),
    label: z.string().nullable().optional()
})

const configSchema = z.object({
    roots: z.array(rootConfigSchema).optional(),
    schedule: z
        .object({
            intervalHours: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12), z.literal(24)]),
            startHour: z.number().int().min(0).max(23).optional(),
            timezone: z.string().min(1).optional()
        })
        .optional(),
    parallelism: z.number().int().positive().optional(),
    globalIgnore: z.array(z.string()).optional(),
    watcherEnabled: z.boolean().optional(),
    // Absolute root paths the lockfile watcher should observe. The watcher is opt-in
    // PER ROOT: an empty array means "watch nothing" (it is NOT a shortcut for "watch all").
    watcherRoots: z.array(z.string()).optional(),
    portalBaseUrl: z.string().optional()
})

export type SentinelloConfig = z.infer<typeof configSchema>

export const CONFIG_KEYS = {
    schedule: 'schedule',
    parallelism: 'parallelism',
    globalIgnore: 'globalIgnore',
    watcherEnabled: 'watcherEnabled',
    watcherRoots: 'watcherRoots',
    portalBaseUrl: 'portalBaseUrl',
    dryRunNotify: 'dryRunNotify',
    notificationLocale: 'notificationLocale'
} as const

const CONFIG_FILE_CANDIDATES = ['sentinello.config.yaml', 'sentinello.config.yml', 'sentinello.config.json']

export function loadConfigFile(cwd: string): SentinelloConfig | null {
    for (const candidate of CONFIG_FILE_CANDIDATES) {
        const fullPath = resolve(cwd, candidate)
        if (!existsSync(fullPath)) continue
        const raw = readFileSync(fullPath, 'utf8')
        const parsed = candidate.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw)
        return configSchema.parse(parsed)
    }
    return null
}

// Seeds roots and app_config on FIRST BOOT ONLY (when the DB has no roots yet).
// Once the operator has begun editing settings in the portal, subsequent boots with the same config
// file present must not clobber DB state. "DB has roots" is the marker for "no longer first boot".
export function seedFromConfig(db: DrizzleDb, config: SentinelloConfig, at: number): void {
    const existingRoots = listRoots(db)
    if (existingRoots.length > 0) return
    if (config.roots && config.roots.length > 0) {
        for (const entry of config.roots) {
            const absolutePath = resolve(entry.path)
            const root: Root = {
                id: rootId(absolutePath),
                path: absolutePath,
                label: entry.label ?? null,
                createdAt: at
            }
            upsertRoot(db, root)
        }
    }
    if (config.schedule) {
        setConfigValue(db, CONFIG_KEYS.schedule, {
            intervalHours: config.schedule.intervalHours,
            startHour: config.schedule.startHour ?? 0,
            timezone: config.schedule.timezone
        })
    }
    if (config.parallelism != null) {
        setConfigValue(db, CONFIG_KEYS.parallelism, config.parallelism)
    }
    if (config.globalIgnore) {
        setConfigValue(db, CONFIG_KEYS.globalIgnore, config.globalIgnore)
    }
    if (config.watcherEnabled != null) {
        setConfigValue(db, CONFIG_KEYS.watcherEnabled, config.watcherEnabled)
    }
    if (config.watcherRoots) {
        const absolutePaths = config.watcherRoots.map(function abs(p) { return resolve(p) })
        setConfigValue(db, CONFIG_KEYS.watcherRoots, absolutePaths)
    }
    if (config.portalBaseUrl) {
        setConfigValue(db, CONFIG_KEYS.portalBaseUrl, config.portalBaseUrl)
    }
}

const DOCKER_ENV_MARKER = '/.dockerenv'
const DOCKER_ROOTS_DIR = '/roots'

// Docker-only convenience: each immediate subdirectory of /roots is treated as a portfolio root and
// auto-registered on boot, so an operator only has to mount `-v /host/path:/roots/<name>` — no env
// var, no manual Settings → Roots step. /roots is OPTIONAL: if it is absent or empty this is a no-op
// and roots can still be added from the portal. Detection is by the /.dockerenv marker Docker writes
// into every container, so on a PM2 / bare-metal host this returns immediately. Existing roots are
// matched by path and left untouched, preserving any label/alias the operator set in the portal.
export function discoverDockerRoots(db: DrizzleDb, at: number): void {
    if (!existsSync(DOCKER_ENV_MARKER)) return
    if (!existsSync(DOCKER_ROOTS_DIR)) return
    const entries = readdirSync(DOCKER_ROOTS_DIR, { withFileTypes: true })
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.')) continue
        const absolutePath = join(DOCKER_ROOTS_DIR, entry.name)
        const existing = getRootByPath(db, absolutePath)
        if (existing) continue
        const root: Root = {
            id: rootId(absolutePath),
            path: absolutePath,
            label: entry.name,
            createdAt: at
        }
        upsertRoot(db, root)
    }
}

// Docker-only mirror of discoverDockerRoots that REMOVES roots whose /roots/<name> mount went
// away between worker boots, along with every project / scan / finding / notification under
// them (cascade lives in deleteRoot). Scope is strictly limited to paths under /roots/ so a
// config-seeded or manually-added root pointing anywhere else on disk is never touched even if
// it is temporarily missing. Detection mirrors discoverDockerRoots (the /.dockerenv marker and
// presence of /roots), so on PM2 / bare-metal hosts this returns immediately.
export function pruneDockerRoots(db: DrizzleDb): { removed: number } {
    if (!existsSync(DOCKER_ENV_MARKER)) return { removed: 0 }
    if (!existsSync(DOCKER_ROOTS_DIR)) return { removed: 0 }
    const entries = readdirSync(DOCKER_ROOTS_DIR, { withFileTypes: true })
    const mounted = new Set<string>()
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.')) continue
        mounted.add(join(DOCKER_ROOTS_DIR, entry.name))
    }
    const dockerPathPrefix = DOCKER_ROOTS_DIR + '/'
    const stale = listRoots(db).filter(function isStale(r) {
        return r.path.startsWith(dockerPathPrefix) && !mounted.has(r.path)
    })
    for (const r of stale) {
        deleteRoot(db, r.id)
    }
    return { removed: stale.length }
}

export const DEFAULT_SCHEDULE = { intervalHours: 24, startHour: 0 } as const

export type IntervalHours = 1 | 3 | 6 | 12 | 24

// timezone is an IANA name (e.g. 'America/Argentina/Buenos_Aires') the startHour is interpreted in.
// When unset, node-cron falls back to the worker's system timezone — same as before this field existed.
export type Schedule = { intervalHours: IntervalHours; startHour?: number; timezone?: string }

// Translate a chosen interval into a node-cron expression, anchored to startHour (0–23, worker local
// time). 1h fires every hour and ignores the anchor. Other intervals fire at startHour and every
// N hours after, listing the exact hours so the cadence begins at the chosen time of day rather than
// at 00:00. e.g. 6h + startHour 2 -> "0 2,8,14,20 * * *"; 24h + startHour 9 -> "0 9 * * *".
export function intervalHoursToCron(hours: IntervalHours, startHour = 0): string {
    const anchor = normalizeStartHour(startHour)
    if (hours === 1) return '0 * * * *'
    const slots: number[] = []
    for (let h = anchor; h < 24; h = h + hours) {
        slots.push(h)
    }
    return '0 ' + slots.join(',') + ' * * *'
}

function normalizeStartHour(startHour: number): number {
    if (!Number.isFinite(startHour)) return 0
    const h = Math.trunc(startHour)
    if (h < 0) return 0
    if (h > 23) return 23
    return h
}
export const DEFAULT_PARALLELISM = 4
export const DEFAULT_GLOBAL_IGNORE: string[] = [
    'node_modules',
    '.git',
    '.next',
    '.turbo',
    'dist',
    'build',
    'out',
    'coverage'
]
