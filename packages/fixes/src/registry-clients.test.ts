import { describe, expect, it } from 'vitest'
import type { EcosystemId } from '@sentinello/core'
import { createMemoryRegistryStore } from './memory-store'
import type { PublicationClient } from './published-registry'
import { fakeRegistry } from './registry-fake.fixture'
import { createRegistryClients, publicationFor } from './registry-clients'
import type { RegistryStore } from './registry-client'

// The factory the worker builds its batch's clients with: one per ecosystem, each over its own store.
// vitest.config.ts points every registry at port 9, so the live fetchers here answer "error" at once.

describe('createRegistryClients', function () {
    it('builds a client for every ecosystem over that ecosystem\'s store', async function () {
        const stores = new Map<EcosystemId, RegistryStore>()
        const clients = createRegistryClients(function storeFor(ecosystem) {
            const store = createMemoryRegistryStore()
            stores.set(ecosystem, store)
            return store
        }, { abortSignal: new AbortController().signal })
        expect([...stores.keys()].sort()).toEqual(['Go', 'PyPI', 'RubyGems', 'crates.io', 'npm'])
        expect(Object.keys(clients).sort()).toEqual(['Go', 'PyPI', 'RubyGems', 'crates.io', 'npm'])
        for (const ecosystem of ['PyPI', 'Go', 'crates.io', 'RubyGems'] as const) {
            const answered = await (clients[ecosystem] as PublicationClient).published(new Map([['pkg', ['1.0.0']]]))
            expect(answered.get('pkg')).toEqual({ status: 'error' })
        }
        expect((await clients.npm?.lookup(['pkg']))?.get('pkg')).toMatchObject({ status: 'error' })
        // A failure is never cached, in any ecosystem's store.
        for (const store of stores.values()) expect(store.get(['pkg']).size).toBe(0)
    })

    it('works without options', function () {
        expect(Object.keys(createRegistryClients(function storeFor() { return createMemoryRegistryStore() }))).toHaveLength(5)
    })
})

describe('publicationFor', function () {
    const pypi: PublicationClient = { published: async function none() { return new Map() } }

    it('finds each ecosystem\'s client, npm\'s seen as settlement sees it, and none for an absent or unknown one', async function () {
        expect(publicationFor({ PyPI: pypi }, 'PyPI')).toBe(pypi)
        expect(publicationFor({ PyPI: pypi }, 'Go')).toBeNull()
        expect(publicationFor({ PyPI: pypi }, 'npm')).toBeNull()
        expect(publicationFor({ PyPI: pypi }, 'constructor')).toBeNull()
        const npm = publicationFor({ npm: fakeRegistry({ braces: { releases: { '3.0.3': {} } } }) }, 'npm')
        expect((await npm?.published(new Map([['braces', []]])))?.get('braces')).toMatchObject({ status: 'ok' })
    })
})
