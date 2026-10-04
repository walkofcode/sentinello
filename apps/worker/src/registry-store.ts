import { getRegistryPackages, setRegistryDownloads, upsertRegistryPackage, type DrizzleDb } from '@sentinello/db'
import type { RegistryStore } from '@sentinello/fixes'

// The worker's RegistryStore: the registry_packages table, npm rows only — the one registry the fix logic
// checks. Shared by every project the worker scans and every scan after it.
const NPM = 'npm'

export function createDbRegistryStore(db: DrizzleDb): RegistryStore {
    return {
        get: function get(names) {
            return getRegistryPackages(db, NPM, names)
        },
        put: function put(row) {
            upsertRegistryPackage(db, { ecosystem: NPM, ...row })
        },
        setDownloads: function setDownloads(name, weeklyDownloads, checkedAt) {
            setRegistryDownloads(db, NPM, name, weeklyDownloads, checkedAt)
        }
    }
}
