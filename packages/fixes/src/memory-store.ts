import type { RegistryRow, RegistryStore } from './registry-client'

// A RegistryStore held in memory, with the same contract as the worker's table: an answer replaces the
// last one but keeps its download count, and a count is only recorded beside an answer. Rows are copied
// in and out, so nothing a reader holds changes under it.
export function createMemoryRegistryStore(initial: Iterable<RegistryRow> = []): RegistryStore {
    const byName = new Map<string, RegistryRow>()
    for (const row of initial) byName.set(row.name, { ...row })
    return {
        get: function get(names) {
            const out = new Map<string, RegistryRow>()
            for (const name of names) {
                const row = byName.get(name)
                if (row) out.set(name, { ...row })
            }
            return out
        },
        put: function put(answer) {
            const previous = byName.get(answer.name)
            byName.set(answer.name, {
                ...answer,
                weeklyDownloads: previous?.weeklyDownloads ?? null,
                downloadsCheckedAt: previous?.downloadsCheckedAt ?? null
            })
        },
        setDownloads: function setDownloads(name, weeklyDownloads, checkedAt) {
            const row = byName.get(name)
            if (row) byName.set(name, { ...row, weeklyDownloads, downloadsCheckedAt: checkedAt })
        }
    }
}
