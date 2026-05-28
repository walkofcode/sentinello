import { sql, type SQL } from 'drizzle-orm'
import type { DepTypeFilter } from '@sentinello/core'

// Append-only filter clause that narrows a findings row to the requested dep-type bucket. Kept as a
// single SQL fragment so each caller interpolates it without restructuring its WHERE clause. The
// alias parameter lets callers point it at whichever findings alias they already used in the FROM /
// JOIN (defaults to 'f', matching most dashboard / library queries).
export function depTypeClause(depType: DepTypeFilter, alias: string = 'f'): SQL {
    if (depType === 'prod') {
        return sql.raw(`AND ${alias}.is_prod = 1`)
    }
    if (depType === 'dev') {
        return sql.raw(`AND ${alias}.is_dev = 1 AND ${alias}.is_prod = 0`)
    }
    return sql.raw('')
}
