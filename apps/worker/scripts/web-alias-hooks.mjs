// Module resolve hook for the scratch tools: maps the portal's `@/` import alias onto apps/web, so a
// worker script can run the portal's own export builder (lib/project-advisory-export.ts) — the code that
// serves get_project_advisory — instead of a re-implementation of it. Registered by the script with
// module.register(); it runs before tsx's hooks, which then compile the resolved .ts file.
const WEB_ROOT = new URL('../../web/', import.meta.url)

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) return nextResolve(new URL(specifier.slice(2) + '.ts', WEB_ROOT).href, context)
    return nextResolve(specifier, context)
}
