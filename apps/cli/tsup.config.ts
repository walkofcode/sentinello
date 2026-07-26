import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'tsup'

// Bundles the CLI into a single self-contained file.
//
// Everything is inlined — the workspace packages and their third-party dependencies alike — so the
// published package.json declares NO runtime dependencies and ships no install script. For a security
// tool people run via npx against their own repositories, "installs nothing, runs nothing on install" is
// a property worth engineering for, not a nice-to-have.
//
// Deliberately NOT minified. The artifact is auditable this way: anyone can read what the tool they just
// piped their dependency tree through actually does, and startup cost is irrelevant next to npm audit.

// The canonical version lives in the monorepo root package.json, maintained by release-please. Reading it
// here is what threads the released version into `sentinello --version`.
function rootVersion(): string {
    const path = resolve(import.meta.dirname, '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
}

export default defineConfig({
    entry: { cli: 'src/cli.ts' },
    // CJS, not ESM. Several bundled dependencies are CommonJS and call require() for node builtins
    // (unzipper reaches for 'util'); inlined into an ESM output those become esbuild's __require shim,
    // which throws "Dynamic require of util is not supported" the moment the archive parser loads.
    // Emitting CJS lets those calls stay real requires and removes the entire interop failure class. The
    // artifact is a binary that nothing imports, so it costs nothing — and the sources use no top-level
    // await or import.meta, which are the only things that would have forced ESM.
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    clean: true,
    minify: false,
    sourcemap: false,
    splitting: false,
    treeshake: true,
    // Bundle every dependency into the output rather than resolving them at runtime — except the AWS SDK.
    // unzipper can read archives straight out of S3 and reaches for @aws-sdk/client-s3 to do it. That
    // require sits inside the S3 code path, which this tool never enters: it only ever streams an HTTP
    // response through unzipper.Parse. The negative lookahead is required because noExternal takes
    // precedence over external, so a blanket /.*/ would drag in the SDK (or fail the build) regardless.
    // Verified after every build by running a real archive download through the built artifact.
    noExternal: [/^(?!@aws-sdk\/).*/],
    external: ['@aws-sdk/client-s3'],
    // No shebang banner here: src/cli.ts already carries one and esbuild preserves it, so adding a banner
    // emits it twice and the second line fails to parse.
    define: {
        __SENTINELLO_VERSION__: JSON.stringify(rootVersion())
    }
})
