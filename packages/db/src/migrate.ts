import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { DrizzleDb } from './client'

// Migrations are isolated from client.ts so the portal's Next.js file-tracing path does not pull in
// fileURLToPath / dirname resolution it never executes. The worker imports runMigrations explicitly
// at boot; the portal opens the DB without touching this module.

export type RunMigrationsOptions = {
    // Override the folder location (used when running outside the package dir, e.g. tests).
    migrationsFolder?: string
}

export function runMigrations(db: DrizzleDb, options?: RunMigrationsOptions): void {
    const folder = options && options.migrationsFolder || defaultMigrationsFolder()
    migrate(db, { migrationsFolder: folder })
}

function defaultMigrationsFolder(): string {
    // Resolve relative to this compiled file's location: <pkg>/dist/migrate.js → <pkg>/drizzle.
    // Use fileURLToPath rather than `new URL('../drizzle/', import.meta.url)` so bundlers do not
    // mistake the URL constructor for a static asset reference.
    const here = fileURLToPath(import.meta.url)
    return resolve(dirname(here), '..', 'drizzle')
}
