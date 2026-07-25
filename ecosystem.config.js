// PM2 ecosystem config.
// Two long-lived apps. Both processes see the same SENTINELLO_DB_PATH so they coordinate through
// exactly one SQLite file. If SENTINELLO_DB_PATH is unset, both apps fall
// back to the same default (<repo>/data/sentinello.sqlite) computed inside packages/db.

// All env vars below are optional. Sensible defaults:
//   SENTINELLO_DB_PATH → <repo>/data/sentinello.sqlite (resolved in packages/db/src/client.ts)
//   ME_NAME            → 'anonymous' (used as mute-author attribution in the portal)
//   PORT               → 3870 (web app only; see apps[0].env below)
// Portal base URL is configured via Settings → Advanced in the portal, not via env.
const { join } = require('node:path')

const sharedEnv = {
    NODE_ENV: 'production',
    SENTINELLO_DB_PATH: process.env.SENTINELLO_DB_PATH || '',
    ME_NAME: process.env.ME_NAME || ''
}

module.exports = {
    apps: [
        {
            name: 'sentinello-web',
            cwd: __dirname,
            script: 'pnpm',
            args: '--filter @sentinello/web start',
            min_uptime: 10000,
            max_restarts: 10,
            restart_delay: 5000,
            kill_timeout: 30000,
            out_file: '~/.pm2/logs/sentinello-web-out.log',
            error_file: '~/.pm2/logs/sentinello-web-error.log',
            env: {
                ...sharedEnv,
                PORT: process.env.PORT || '3870'
            }
        },
        {
            name: 'sentinello-worker',
            // cwd is the worker package, NOT the repo root: the worker reads its optional config file
            // relative to process.cwd(). `pnpm --filter` used to supply this cwd implicitly.
            cwd: join(__dirname, 'apps', 'worker'),
            // Worker runs straight from TypeScript source via tsx (no dist/ build step), launched as a
            // SINGLE node process — deliberately NOT via `pnpm --filter ... start` like sentinello-web
            // above. That indirection put two layers between pm2 and the worker (pnpm, then the
            // .bin/tsx shell shim, which forks rather than execs), and pm2 signals only the process it
            // spawned. SIGTERM therefore never reached the worker: its shutdown handler never ran, so
            // an in-flight scan died mid-write and the single-instance lock was never released,
            // leaving the next container to restart-loop ~30s until that lock aged out as stale.
            // `node --import tsx src/index.ts` has no wrapper and no child, so the signal lands on the
            // worker itself. Verified: no intermediate pids, and the handler runs on SIGTERM.
            script: 'src/index.ts',
            interpreter: 'node',
            interpreter_args: '--import tsx',
            min_uptime: 10000,
            max_restarts: 10,
            restart_delay: 5000,
            // Worker grace period is 30s for in-flight scans + 5s force-exit; give PM2 a slightly
            // larger window so the worker can drain cleanly before SIGKILL.
            kill_timeout: 45000,
            out_file: '~/.pm2/logs/sentinello-worker-out.log',
            error_file: '~/.pm2/logs/sentinello-worker-error.log',
            env: { ...sharedEnv }
        }
    ]
}
