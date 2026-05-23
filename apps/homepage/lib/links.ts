// Canonical external links + the exact Docker quick-start, kept in one place so copy stays in sync
// with the repo README. The run command mirrors README.md's Quick start verbatim.
export const GITHUB_REPO = 'walkofcode/sentinello'
export const GITHUB_URL = 'https://github.com/walkofcode/sentinello'
export const GITHUB_ISSUES_URL = 'https://github.com/walkofcode/sentinello/issues'
export const GITHUB_API_URL = 'https://api.github.com/repos/walkofcode/sentinello'
export const WEBSITE_URL = 'https://sentinello.org'
export const WALKOFCODE_URL = 'https://walkofcode.io'
export const LICENSE_URL = 'https://github.com/walkofcode/sentinello/blob/main/LICENSE'
export const IMAGE_REF = 'ghcr.io/walkofcode/sentinello:latest'

export const DOCKER_RUN_COMMAND = `docker run -d \\
  --name sentinello \\
  -p 3870:3000 \\
  -v sentinello-data:/app/data \\
  -v sentinello-nvm:/root/.nvm \\
  -v ~/Developer:/roots/personal:ro \\
  ghcr.io/walkofcode/sentinello:latest`

export const DOCKER_COMPOSE_SNIPPET = `services:
    sentinello:
        image: ghcr.io/walkofcode/sentinello:latest
        container_name: sentinello
        restart: unless-stopped
        ports:
            - '3870:3000'
        volumes:
            - sentinello-data:/app/data
            - sentinello-nvm:/root/.nvm
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
