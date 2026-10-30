import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { DrizzleDb } from './client'

// Migrations are isolated from client.ts so the portal's Next.js file-tracing path does not pull in
// fileURLToPath / dirname resolution it never executes. The worker imports runMigrations explicitly
// at boot; the portal opens the DB without touching this module.

export type RunMigrationsOptions = {
    // Override the folder location (used when running outside the package dir, e.g. tests).
    migrationsFolder?: string
}

// drizzle-kit writes a table rebuild (CREATE __new_x, copy, DROP x, RENAME) between `PRAGMA foreign_keys=OFF`
// and `=ON`, but the migrator runs every migration inside one transaction, where SQLite ignores that pragma.
// With enforcement on, dropping a table other tables reference (scans, which findings and notification
// events point at) fails the whole upgrade. So enforcement is switched off around the migrator — outside its
// transaction, where the pragma takes effect — and the foreign keys are checked before it is switched back
// on, which is SQLite's own procedure for a table rebuild (https://sqlite.org/lang_altertable.html, steps 1
// and 10). A migration that left a dangling reference fails loudly here instead of booting.
export function runMigrations(db: DrizzleDb, options?: RunMigrationsOptions): void {
    const folder = options && options.migrationsFolder || defaultMigrationsFolder()
    const enforced = db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`).foreign_keys === 1
    if (enforced) db.run(sql`PRAGMA foreign_keys = OFF`)
    try {
        migrate(db, { migrationsFolder: folder })
        const violations = db.all(sql`PRAGMA foreign_key_check`)
        if (violations.length > 0) throw new Error('migration left ' + violations.length + ' foreign key violation(s): ' + JSON.stringify(violations.slice(0, 5)))
    } finally {
        if (enforced) db.run(sql`PRAGMA foreign_keys = ON`)
    }
}

function defaultMigrationsFolder(): string {
    // Resolve relative to this compiled file's location: <pkg>/dist/migrate.js → <pkg>/drizzle.
    // Use fileURLToPath rather than `new URL('../drizzle/', import.meta.url)` so bundlers do not
    // mistake the URL constructor for a static asset reference.
    const here = fileURLToPath(import.meta.url)
    return resolve(dirname(here), '..', 'drizzle')
}
