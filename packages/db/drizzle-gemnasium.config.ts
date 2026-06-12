import type { Config } from 'drizzle-kit'

// Separate drizzle target for the gemnasium advisory cache (gemnasium.db). Its own schema, its own
// migrations folder and its own journal so it never tangles with the primary sentinello.sqlite or the
// OSV cache migrations. Generate with: pnpm --filter @sentinello/db db:generate:gemnasium
const config: Config = {
    schema: './src/gemnasium-schema.ts',
    out: './drizzle-gemnasium',
    dialect: 'sqlite',
    migrations: {
        table: '__drizzle_migrations_gemnasium'
    }
}

export default config
