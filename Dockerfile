# Sentinello v1 — multi-stage single-image deployment running both apps under pm2-runtime.
#
# Stages:
#   base    — minimal runtime foundation (node:24.14.0-bookworm-slim + corepack/pnpm + nvm + tini)
#   deps    — adds python3/build-essential so better-sqlite3 / esbuild / sharp can compile
#   build   — copies full source and runs `pnpm turbo run build`
#   runtime — copies build output onto `base` (no compilers, no apt cache) and starts pm2-runtime
#
# Why nvm is in the runtime image: the worker shells out to `nvm install` for .nvmrc-aware scans of
# user-mounted portfolio roots (apps/worker/src/discovery.ts, apps/worker/src/runner.ts). The
# *runtime* Node version is pinned to 24.14.0 by the base image — nvm is only there so scans of
# arbitrary `.nvmrc` files in mounted roots behave the same as on a PM2 host. `nvm install` pulls
# any missing version on first scan; persist /home/sentinello/.nvm (see docker-compose.yml) so it
# happens once.
#
# Runs non-root: the `runtime` stage creates an unprivileged `sentinello` user and installs nvm +
# the baseline Node fresh into that user's home (nvm is only used at runtime — the build stages use
# the image's pinned Node). The web server, worker, and every audit subprocess run as that user, so a
# scan-runner compromise or container escape does not land as root.

# ---------------------------------------------------------------------------
# Stage 1: base — the foundation for both `deps` and `runtime`. Keep this lean.
# ---------------------------------------------------------------------------
FROM node:24.14.0-bookworm-slim AS base

ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# tini gives us correct SIGTERM/SIGINT propagation to pm2-runtime's child Node processes.
# curl + ca-certificates are needed for the runtime-stage nvm install and the HEALTHCHECK; git is
# required by some pnpm git-protocol resolutions even at runtime if any dep ever uses one.
# libatomic1 is required to RUN newer Node majors (>= 25) that nvm installs for .nvmrc-aware scans —
# their binaries link against libatomic.so.1, which the slim base image does not ship by default.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl ca-certificates git tini libatomic1 \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm matching the version pinned in package.json (build stages use it; the runtime stage
# re-activates it for the sentinello user).
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# ---------------------------------------------------------------------------
# Stage 2: deps — install workspace dependencies. Has compilers; never shipped.
# ---------------------------------------------------------------------------
FROM base AS deps

# Native-build toolchain for better-sqlite3, esbuild, sharp (allowlisted in pnpm-workspace.yaml).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy lockfile + workspace metadata first so the install layer caches on the lockfile alone.
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .npmrc ./

# Workspace manifests only — re-running `pnpm install` because one of these changed is cheap;
# re-running because a random src file changed is what we're avoiding here.
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/notifications/package.json packages/notifications/
COPY packages/scanners/package.json packages/scanners/

# Strict-mode install — exact versions only, .npmrc minimum-release-age in force.
#
# The cache mount on pnpm's content-addressable store persists across buildkit invocations
# (it lives inside the GHA cache scope written by `cache-to: type=gha,mode=max,scope=<platform>`
# in .github/workflows/docker-publish.yml). When only some workspace manifests change, pnpm
# resolves to the same content hashes and the download phase is skipped. For first builds on a
# cold runner the mount is empty and behaves like a regular install.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,id=pnpm-store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 3: build — full source + turbo build. Produces .next/standalone for web and
# leaves the worker TS source on disk (worker runs via tsx, no dist).
# ---------------------------------------------------------------------------
FROM deps AS build

COPY apps ./apps
COPY packages ./packages
COPY ecosystem.config.js ./

# The image ships only the portal (web + worker) and their workspace deps; apps/homepage is the
# standalone marketing site (sentinello.org), excluded from the build context via .dockerignore.
# Scope the build to the runtime apps so turbo never looks for the absent homepage package.
RUN pnpm turbo run build --filter=@sentinello/web --filter=@sentinello/worker

# ---------------------------------------------------------------------------
# Stage 4: runtime — lean image. No compilers, no apt cache.
# ---------------------------------------------------------------------------
FROM base AS runtime

# pm2-runtime is the foreground process supervisor inside the container.
RUN npm install -g pm2@5.4.3

# Unprivileged runtime user. Fixed uid so host bind mounts / named volumes have a stable owner to
# match. Everything below runs as this user via the final USER instruction.
RUN useradd --create-home --shell /bin/bash --uid 10001 sentinello

WORKDIR /app

# Copy /app wholesale from the build stage. This drops ~400MB of apt build-tools
# vs the previous single-stage Dockerfile while keeping the worker's TS source
# available (tsx executes it directly — there's no dist/ artifact to copy alone).
COPY --from=build --chown=sentinello:sentinello /app /app

# Create the data dir up front so the named volume inherits sentinello ownership on first creation.
RUN mkdir -p /app/data && chown sentinello:sentinello /app/data

# Runtime user's home-based paths. The worker sources nvm via `~/.nvm/nvm.sh` and pm2 writes to
# `~/.pm2`, so HOME must point at the sentinello home.
ENV HOME=/home/sentinello
ENV NVM_DIR=/home/sentinello/.nvm
ENV PNPM_HOME=/home/sentinello/.local/share/pnpm
ENV PATH=/home/sentinello/.local/share/pnpm:$PATH

# Everything from here runs as the unprivileged user. tini still runs as PID 1 but immediately execs
# pm2-runtime as sentinello, so the web server, worker, and audit subprocesses never run as root.
USER sentinello

# Activate the pinned pnpm (pm2 launches both apps via `pnpm --filter ... start`) and install nvm +
# the baseline Node — all in the sentinello home so they are owned correctly with no root-owned files
# to carry. nvm is only used at runtime, for `.nvmrc`-aware scans of mounted roots; `nvm install`
# pulls any missing version on first scan and persists it in /home/sentinello/.nvm (see compose).
# When bumping NVM_VERSION, refresh NVM_INSTALL_SHA256 or the sha256sum check below fails — see
# https://github.com/nvm-sh/nvm/releases (hash: curl <install.sh URL> | sha256sum).
ARG NVM_VERSION=0.40.1
ARG NVM_INSTALL_SHA256=abdb525ee9f5b48b34d8ed9fc67c6013fb0f659712e401ecd88ab989b3af8f53
RUN corepack prepare pnpm@10.33.0 --activate \
    && curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" -o /tmp/nvm-install.sh \
    && echo "${NVM_INSTALL_SHA256}  /tmp/nvm-install.sh" | sha256sum -c - \
    && bash /tmp/nvm-install.sh \
    && rm /tmp/nvm-install.sh \
    && bash -lc "source $NVM_DIR/nvm.sh && nvm install 24.14.0 && nvm alias default 24.14.0"

# Version label baked in at build time. docker-publish.yml passes the resolved SemVer
# from the triggering git tag. Local `pnpm docker:build` injects the root package.json
# version. Both the UI footer and /api/health read process.env.SENTINELLO_VERSION.
ARG SENTINELLO_VERSION=dev
ENV SENTINELLO_VERSION=${SENTINELLO_VERSION}

# OCI image annotations — Docker Hub, GHCR, and orchestrators surface these in the UI.
# docker-publish.yml's metadata-action emits a superset on push; these are belt-and-suspenders
# for anyone who does their own `docker build`.
LABEL org.opencontainers.image.title="Sentinello" \
      org.opencontainers.image.description="Centralized dependency-vulnerability monitoring portal" \
      org.opencontainers.image.url="https://sentinello.org" \
      org.opencontainers.image.source="https://github.com/walkofcode/sentinello" \
      org.opencontainers.image.documentation="https://sentinello.org" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Walk of Code LLC" \
      org.opencontainers.image.version=${SENTINELLO_VERSION}

ENV NODE_ENV=production

# Volume mount point: the SQLite file, its WAL/SHM siblings, and the worker lock all live here.
ENV SENTINELLO_DB_PATH=/app/data/sentinello.sqlite
VOLUME ["/app/data"]

# Default port for the web app. Operators can remap on the host.
ENV PORT=3000
EXPOSE 3000

# Orchestrators (compose, k8s, Portainer) use this to detect a wedged web process.
# The route runs a SELECT 1 against the shared SQLite to assert end-to-end health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT}/api/health" || exit 1

# tini -> pm2-runtime keeps the container alive — exiting only when both apps exit,
# and propagating SIGTERM cleanly so the worker can drain in-flight scans.
#
# Before starting, refuse to run if the nvm cache is misconfigured for the non-root switch, and stop
# the whole container with an actionable message rather than limping along. Two cases:
#   1. The old `sentinello-nvm:/root/.nvm` mount is still in the compose — detected via
#      /proc/self/mountinfo (world-readable, so the non-root user sees the mount even though it can't
#      traverse root-owned /root).
#   2. The volume was remounted at the new path but is the SAME root-owned volume from a pre-non-root
#      release — detected by NVM_DIR not being writable by the runtime user.
# Either way the fix is: `docker volume rm sentinello-nvm` and remount at /home/sentinello/.nvm.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "if grep -q ' /root/.nvm ' /proc/self/mountinfo 2>/dev/null; then echo '[sentinello] FATAL: the old sentinello-nvm:/root/.nvm volume is still mounted from a pre-non-root release. The nvm cache now lives at /home/sentinello/.nvm. Delete the volume (docker volume rm sentinello-nvm) and remount it at /home/sentinello/.nvm per the README upgrade note. Refusing to start.' >&2; exit 1; fi; if [ ! -w $NVM_DIR ]; then echo '[sentinello] FATAL: /home/sentinello/.nvm is not writable by the non-root user. The sentinello-nvm volume is root-owned from a pre-non-root release. Delete it (docker volume rm sentinello-nvm) so it is recreated fresh — it is a cache, nothing is lost. Refusing to start.' >&2; exit 1; fi; exec pm2-runtime start ecosystem.config.js"]
