import type { Config } from 'drizzle-kit'

// Separate drizzle target for the OSV advisory cache (osv.db). Its own schema, its own migrations
// folder and its own journal so it never tangles with the primary sentinello.sqlite migrations.
// Generate with: pnpm --filter @sentinello/db db:generate:osv
const config: Config = {
    schema: './src/osv-schema.ts',
    out: './drizzle-osv',
    dialect: 'sqlite',
    migrations: {
        table: '__drizzle_migrations_osv'
    }
}

export default config
