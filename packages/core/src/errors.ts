// Coercing an `unknown` from a catch block into something loggable. Both shapes were hand-inlined at a
// dozen call sites across the CLI, the worker, the portal and the scanners before they moved here, and
// every copy carried the same untestable arm: behind a collaborator that only ever throws Error —
// node:fs, better-sqlite3, JSON.parse, a node stream pipeline — the non-Error side is dead at that call
// site and reachable only here, where it can be driven directly.

// `err.message || String(err)` rather than `err.message` alone: an Error carrying an empty message
// would otherwise log as nothing at all, and a blank line tells an operator less than 'Error' does.
// This is what the `err instanceof Error && err.message || String(err)` form the call sites used to
// spell out already did — the behaviour is preserved, not the duplication.
export function errText(err: unknown): string {
    if (err instanceof Error) return err.message || String(err)
    return String(err)
}

// Preserves the original Error — including its stack and `cause` — rather than rebuilding one from the
// message, which is why this is not `new Error(errText(err))`.
export function asError(err: unknown): Error {
    if (err instanceof Error) return err
    return new Error(String(err))
}
