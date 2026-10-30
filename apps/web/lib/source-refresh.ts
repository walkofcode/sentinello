import type { SourceStatus } from '@sentinello/core'

// Client-safe: the Settings → Sources form imports it, so it must not pull @sentinello/db in. Lives outside
// the component because .tsx is outside the coverage globs.

// The status as it stood when Refresh was clicked.
export type RefreshBaseline = {
    refreshedAt: number | null
    lastError: string | null
}

// Whether a refresh the operator asked for is still under way: the worker has stamped a sync as running, or
// nothing it writes has changed since the click — neither the refresh time nor the error. Derived from the
// server's status on every render, so a refresh reads finished the moment the snapshot moves on.
export function isRefreshPending(status: SourceStatus | null, baseline: RefreshBaseline | null): boolean {
    if (status !== null && (status.syncStartedAt ?? null) !== null) return true
    return baseline !== null
        && (status?.refreshedAt ?? null) === baseline.refreshedAt
        && (status?.lastError ?? null) === baseline.lastError
}
