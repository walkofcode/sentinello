import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// End-to-end suites, kept out of the default `pnpm test` run because they need a built artifact and
// take seconds rather than milliseconds. The CLI suite drives the real bundled binary as a
// subprocess — the same file npm publishes — so it catches packaging faults (a missing bundled
// dependency, a broken shebang, a stray import) that no in-process test can see.
export default defineConfig({
    resolve: {
        // tests/ sits at the repo root rather than inside a workspace package, and pnpm does not
        // hoist, so the @sentinello/* specifiers have no node_modules link to resolve through.
        // Point them straight at the source, which is what the workspace packages export anyway.
        alias: {
            '@sentinello/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
            '@sentinello/scanners': fileURLToPath(new URL('./packages/scanners/src/index.ts', import.meta.url)),
            '@sentinello/feeds': fileURLToPath(new URL('./packages/feeds/src/index.ts', import.meta.url))
        }
    },
    test: {
        environment: 'node',
        include: ['tests/e2e/**/*.e2e.test.ts'],
        // Building and shelling out is slow relative to a unit test.
        testTimeout: 120_000,
        hookTimeout: 180_000,
        pool: 'forks'
    }
})
