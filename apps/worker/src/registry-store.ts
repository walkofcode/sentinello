import type { EcosystemId } from '@sentinello/core'
import { getRegistryPackages, setRegistryDownloads, upsertRegistryPackage, type DrizzleDb } from '@sentinello/db'
import type { RegistryStore, RegistryStoreFor } from '@sentinello/fixes'

// The worker's RegistryStore: the registry_packages table, one ecosystem's rows — each registry's client
// keeps its own answers, keyed (ecosystem, name). Shared by every project the worker scans and every scan
// after it.
export function createDbRegistryStore(db: DrizzleDb, ecosystem: EcosystemId): RegistryStore {
    return {
        get: function get(names) {
            return getRegistryPackages(db, ecosystem, names)
        },
        put: function put(row) {
            upsertRegistryPackage(db, { ecosystem, ...row })
        },
        setDownloads: function setDownloads(name, weeklyDownloads, checkedAt) {
            setRegistryDownloads(db, ecosystem, name, weeklyDownloads, checkedAt)
        }
    }
}

// Every ecosystem's store over the same table, as createRegistryClients asks for them.
export function createDbRegistryStores(db: DrizzleDb): RegistryStoreFor {
    return function storeFor(ecosystem) {
        return createDbRegistryStore(db, ecosystem)
    }
}
