// PM2 ecosystem config.
// Two long-lived apps. Both processes see the same SENTINELLO_DB_PATH so they coordinate through
// exactly one SQLite file. If SENTINELLO_DB_PATH is unset, both apps fall
// back to the same default (<repo>/data/sentinello.sqlite) computed inside packages/db.

// All env vars below are optional. Sensible defaults:
//   SENTINELLO_DB_PATH → <repo>/data/sentinello.sqlite (resolved in packages/db/src/client.ts)
//   ME_NAME            → 'anonymous' (used as mute-author attribution in the portal)
//   PORT               → 3870 (web app only; see apps[0].env below)
// Portal base URL is configured via Settings → Advanced in the portal, not via env.
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
            cwd: __dirname,
            // Worker runs straight from TypeScript source via tsx (no dist/ build step). Going through
            // `pnpm --filter` keeps the invocation symmetric with sentinello-web above and lets pnpm
            // resolve the tsx binary out of the worker workspace's node_modules.
            script: 'pnpm',
            args: '--filter @sentinello/worker start',
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
