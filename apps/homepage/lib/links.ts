// Canonical external links + the exact Docker quick-start, kept in one place so copy stays in sync
// with the repo README.
//
// The contract with README.md is parity on every FUNCTIONAL line — ports, volumes, flags, environment.
// Explanatory comments are trimmed, since a landing page is not the place to read them, and the roots
// mount is a concrete path rather than the README's placeholder. Anything else that differs is drift:
// these snippets are the first thing a visitor pastes into a shell, so a stale line here is a broken
// install or, in the case of the port binding, an unauthenticated portal on every interface.
export const GITHUB_REPO = 'walkofcode/sentinello'
export const GITHUB_URL = 'https://github.com/walkofcode/sentinello'
export const GITHUB_ISSUES_URL = 'https://github.com/walkofcode/sentinello/issues'
export const GITHUB_API_URL = 'https://api.github.com/repos/walkofcode/sentinello'
export const WEBSITE_URL = 'https://sentinello.org'
export const WALKOFCODE_URL = 'https://walkofcode.io'
export const LICENSE_URL = 'https://github.com/walkofcode/sentinello/blob/main/LICENSE'
export const IMAGE_REF = 'ghcr.io/walkofcode/sentinello:latest'
export const NPM_PACKAGE_URL = 'https://www.npmjs.com/package/sentinello'
export const CLI_DOCS_URL = 'https://github.com/walkofcode/sentinello/blob/main/docs/cli.md'

// The CLI's two headline invocations, mirroring apps/cli/README.md. The pipe form is the differentiator
// and is shown in full: piped, stdout carries only the markdown, so the document reaches the agent intact.
export const NPX_COMMAND = 'npx sentinello'
export const NPX_PIPE_COMMAND = 'npx sentinello | claude -p "$(cat -)"'

export const DOCKER_RUN_COMMAND = `docker run -d \\
  --name sentinello \\
  -p 127.0.0.1:3870:3000 \\
  --stop-timeout 60 \\
  -v sentinello-data:/app/data \\
  -v sentinello-nvm:/home/sentinello/.nvm \\
  -v ~/Developer:/roots/personal:ro \\
  ghcr.io/walkofcode/sentinello:latest`

export const DOCKER_COMPOSE_SNIPPET = `services:
    sentinello:
        image: ghcr.io/walkofcode/sentinello:latest
        container_name: sentinello
        restart: unless-stopped
        # Room for the worker to drain an in-flight scan and release its lock.
        stop_grace_period: 60s
        security_opt:
            - no-new-privileges:true
        cap_drop:
            - ALL
        ports:
            # Localhost-only; drop the prefix to expose it — and add auth first.
            - '127.0.0.1:3870:3000'
        environment:
            SENTINELLO_DB_PATH: /app/data/sentinello.sqlite
            # The address people open in a browser, not the mapping above: every
            # notification link is built from it.
            SENTINELLO_PORTAL_BASE_URL: http://localhost:3870
            # Optional login gate — set a long random string to require /login:
            # SENTINELLO_PORTAL_TOKEN: change-me-to-a-long-random-string
        volumes:
            - sentinello-data:/app/data
            - sentinello-nvm:/home/sentinello/.nvm
            # One read-only mount per root; each is auto-registered on boot.
            - \${HOME}/Developer:/roots/personal:ro

volumes:
    sentinello-data:
    sentinello-nvm:`

// pm2 (no Docker) — mirrors README.md "Running with pm2 (without Docker)" verbatim. The portal
// comes up on :3870 by default; there is no /roots auto-mount, so roots are added in the portal.
export const PM2_SNIPPET = `pnpm install
pnpm build
pm2 start ecosystem.config.js

# Portal → http://localhost:3870  (set PORT to change)
# No /roots auto-mount here — add code roots from Settings → Roots`
