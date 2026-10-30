import type { RegistryResult } from './request'

// What the PyPI, crates.io, Go and RubyGems clients keep of a package: which versions were published, and
// whether each one was since yanked. That is all settlement asks of those registries — a fix version is
// a fact once it is published and not withdrawn — so it is all that gets cached. npm keeps more (its
// summary also feeds the way out, which is computed for npm only).

export type PublishedRelease = {
    // True when the registry withdrew the release: it stays resolvable for an exact pin, but no resolver
    // picks it for a range, so it is never offered as a fix.
    yanked: boolean
}

export type PublishedSummary = {
    v: 1
    name: string
    // Every published version, in the registry's own spelling.
    versions: Record<string, PublishedRelease>
}

export type PublishedResult = RegistryResult<PublishedSummary>
