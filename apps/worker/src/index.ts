import { main } from './worker'

// The worker bin. Everything it does lives in ./worker — this file exists only to run it.
//
// The split is what makes main() and makeShutdown() testable: importing THIS module boots a worker
// (acquires the single-instance lock, opens the database, arms cron), so a test could never import it.
//
// The filename is load-bearing and must not change. ecosystem.config.js sets
// `script: 'src/index.ts'` with `interpreter: 'node'` / `interpreter_args: '--import tsx'`, and the
// comment there records why: launching via `pnpm --filter` once put two processes between pm2 and the
// worker, pm2 signalled only the one it spawned, and SIGTERM never arrived — the shutdown handler
// never ran, an in-flight scan died mid-write, and the single-instance lock stayed held until it aged
// out as stale, restart-looping the container for ~30s. apps/worker/package.json's dev/start scripts
// and the Dockerfile point here too.

main().catch(function onMainError(err: unknown) {
    const message = err instanceof Error && err.message || String(err)
    console.error('[worker] fatal: ' + message)
    process.exit(1)
})
