import { all, resolveDocUrl, type ManifestModule, type ModuleReplacement } from 'module-replacements'

// The curated replacement dataset (e18e's module-replacements, decision D2): the only place the way-out
// guidance takes an alternative package from. No search heuristic stands in when it has no entry — the
// guidance then says that no curated alternative is known.

export type CuratedReplacement =
    | { kind: 'module'; name: string }
    | { kind: 'native'; id: string; description: string | null; url: string | null }
    | { kind: 'snippet'; id: string; description: string; url: string | null }
    | { kind: 'removal'; description: string; url: string | null }

export type CuratedEntry = { replaces: string; url: string | null; replacements: CuratedReplacement[] }

export type ReplacementDataset = (name: string) => CuratedEntry | null

export function createReplacementDataset(manifest: ManifestModule = all): ReplacementDataset {
    return function lookup(name: string): CuratedEntry | null {
        const mapping = Object.hasOwn(manifest.mappings, name) ? manifest.mappings[name] : undefined
        if (!mapping) return null
        const replacements: CuratedReplacement[] = []
        for (const id of mapping.replacements) {
            const replacement = Object.hasOwn(manifest.replacements, id) ? manifest.replacements[id] : undefined
            if (replacement) replacements.push(toCurated(replacement))
        }
        return { replaces: name, url: resolveDocUrl(mapping.url), replacements }
    }
}

function toCurated(r: ModuleReplacement): CuratedReplacement {
    if (r.type === 'documented') return { kind: 'module', name: r.replacementModule }
    if (r.type === 'native') return { kind: 'native', id: r.id, description: r.description ?? null, url: resolveDocUrl(r.url) }
    if (r.type === 'simple') return { kind: 'snippet', id: r.id, description: r.description, url: resolveDocUrl(r.url) }
    return { kind: 'removal', description: r.description, url: resolveDocUrl(r.url) }
}
