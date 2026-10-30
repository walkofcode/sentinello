import { getEcosystem, type EcosystemId } from '@sentinello/core'
import { fetchCratesPackage, fetchPypiPackage, fetchRubyGemsPackage } from '@sentinello/feeds'
import { createGoRegistryClient } from './go-registry'
import { createPublishedRegistryClient, npmPublication, type PublicationClient } from './published-registry'
import { createNpmRegistryClient, type RegistryClient, type RegistryStore } from './registry-client'

// The registry each ecosystem's fixes are settled against, one client per ecosystem. An ecosystem with no
// client here is not checked: its findings settle `unverified`, marked skipped, with the fix their sources
// state. npm's client is the richer package-data one, because the way out is computed for npm only (and
// reads it); every other is the settlement view alone.
export type RegistryClients = { npm?: RegistryClient } & { [E in Exclude<EcosystemId, 'npm'>]?: PublicationClient }

// Where each ecosystem's client keeps its answers: the worker's registry_packages rows for that ecosystem.
export type RegistryStoreFor = (ecosystem: EcosystemId) => RegistryStore

export type RegistryClientsOptions = { abortSignal?: AbortSignal }

// Every registry settlement can check, each cache-first over its own store. One set serves a whole worker
// batch: each client's concurrency limit and in-flight joins are per registry, across every project.
export function createRegistryClients(storeFor: RegistryStoreFor, options?: RegistryClientsOptions): RegistryClients {
    const shared = { abortSignal: options?.abortSignal }
    return {
        npm: createNpmRegistryClient(storeFor('npm'), shared),
        PyPI: createPublishedRegistryClient(storeFor('PyPI'), fetchPypiPackage, shared),
        Go: createGoRegistryClient(storeFor('Go'), shared),
        'crates.io': createPublishedRegistryClient(storeFor('crates.io'), fetchCratesPackage, shared),
        RubyGems: createPublishedRegistryClient(storeFor('RubyGems'), fetchRubyGemsPackage, shared)
    }
}

// The settlement view of one ecosystem's registry; null when the map has none for it, or the ecosystem is
// not one the registry knows.
export function publicationFor(clients: RegistryClients, ecosystem: string): PublicationClient | null {
    const id = getEcosystem(ecosystem)?.id
    if (id === undefined) return null
    if (id === 'npm') return clients.npm ? npmPublication(clients.npm) : null
    return clients[id] ?? null
}
