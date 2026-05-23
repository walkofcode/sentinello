import { getConfigValue, type DrizzleDb } from '@sentinello/db'
import type { DepTypeFilter, Severity } from '@sentinello/core'

// Single appConfig key holds every filter default the operator has tuned. Keeping them in one
// JSON blob means the Settings → Defaults page writes one row and the homepage/detail pages
// read one row — no per-key migration churn as we add more defaults later.
const FILTER_DEFAULTS_KEY = 'filterDefaults'

export type FilterDefaults = {
    depType: DepTypeFilter
    minSeverity: '' | Severity
    sort: string
}

const BUILT_IN_DEFAULTS: FilterDefaults = {
    depType: 'prod',
    minSeverity: '',
    sort: 'severity'
}

const VALID_DEP_TYPES: DepTypeFilter[] = ['all', 'prod', 'dev']
const VALID_SEVERITIES: ('' | Severity)[] = ['', 'critical', 'high', 'moderate', 'low', 'info']

export function getFilterDefaults(db: DrizzleDb): FilterDefaults {
    const raw = getConfigValue<unknown>(db, FILTER_DEFAULTS_KEY)
    if (!raw || typeof raw !== 'object') return BUILT_IN_DEFAULTS
    const obj = raw as Record<string, unknown>
    const out: FilterDefaults = { ...BUILT_IN_DEFAULTS }
    if (typeof obj.depType === 'string' && (VALID_DEP_TYPES as string[]).includes(obj.depType)) {
        out.depType = obj.depType as DepTypeFilter
    }
    if (typeof obj.minSeverity === 'string' && (VALID_SEVERITIES as string[]).includes(obj.minSeverity)) {
        out.minSeverity = obj.minSeverity as '' | Severity
    }
    if (typeof obj.sort === 'string') {
        out.sort = obj.sort
    }
    return out
}

export function parseDepTypeParam(value: string | undefined | null): DepTypeFilter | null {
    if (!value) return null
    if (value === 'all' || value === 'prod' || value === 'dev') return value
    return null
}

export const FILTER_DEFAULTS_CONFIG_KEY = FILTER_DEFAULTS_KEY
