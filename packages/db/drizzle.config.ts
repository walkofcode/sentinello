import type { Config } from 'drizzle-kit'

const config: Config = {
    schema: './src/schema.ts',
    out: './drizzle',
    dialect: 'sqlite'
}

export default config
