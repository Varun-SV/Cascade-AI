# ─────────────────────────────────────────────
#  Cascade Cloud — self-host image
#
#  Multi-stage build: the "build" stage installs the npm-workspaces monorepo
#  and builds the root SDK, the cloud/web SPA, and cloud/server; the
#  "runtime" stage carries only the compiled output + production
#  dependencies needed to run `node dist/index.js`. cloud/server serves the
#  built cloud/web SPA statically (see cloud/server/src/app.ts), so this one
#  image is the whole app — no separate web container.
#
#  Quickest way to run this: see docker-compose.yml + .env.example.
# ─────────────────────────────────────────────

# Node major version pinned to match .github/workflows/ci.yml (Node 22).
FROM node:22-slim AS build
WORKDIR /repo

# better-sqlite3 (used by cloud/server and the core SDK) ships prebuilt
# binaries for most platforms, but keep a source-build fallback so an image
# built on a platform/Node ABI without a prebuild doesn't just fail.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install first from the full source tree: this is an npm-workspaces
# monorepo (root package.json "workspaces": web, app, cloud/server,
# cloud/web) and cloud/server's own build pulls in the root SDK build too
# (see below), so `npm ci` needs every workspace's package.json present.
COPY . .
RUN npm ci

# Builds cloud/server. Its "prebuild" hook (npm script) runs first and does
# two things `npm run build -w cascade-cloud-server` triggers automatically:
#   1. builds the root SDK (tsup) that cloud/server consumes,
#   2. regenerates cloud/server/vendor/cascade-ai.js — a symlink back to the
#      root SDK's dist/index.js, which is what cloud/server's private
#      "#cascade-ai" import (package.json "imports" field) resolves to.
# Without that vendor symlink the server fails to boot with
# ERR_MODULE_NOT_FOUND, so it — and the root dist/ it points at — both have
# to make it into the runtime stage below.
RUN npm run build -w cascade-cloud-server

# Builds the web SPA (`tsc && vite build` → cloud/web/dist). cloud/server
# serves this directory statically when it exists (see app.ts), which is
# the whole reason this is a single-container self-host, not two.
RUN npm run build -w cascade-cloud-web

# Drop devDependencies (typescript, tsup, vite, vitest, playwright, …) now
# that everything is already built — the runtime stage only copies what's
# left here.
RUN npm prune --omit=dev

# ─────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo

# Non-root runtime user.
RUN groupadd --system --gid 1001 cascade \
    && useradd --system --uid 1001 --gid cascade --home-dir /repo --shell /usr/sbin/nologin cascade

# Production node_modules (hoisted at the workspace root) + the root
# package.json they were pruned against.
COPY --from=build --chown=cascade:cascade /repo/node_modules ./node_modules
COPY --from=build --chown=cascade:cascade /repo/package.json ./package.json

# The root SDK build — only the files cloud/server's vendor symlink actually
# points at; the CLI/desktop bundles (dist/cli.*, dist/desktop-core.cjs) are
# not needed to run the cloud server and are left behind to keep the image
# smaller.
COPY --from=build --chown=cascade:cascade /repo/dist/index.js ./dist/index.js

# cloud/server's own build output + its package.json ("imports" field +
# "type": "module") + the vendor symlink the "#cascade-ai" import resolves
# through (see the comment on the build stage above — this is the file that
# is easy to forget and makes the container boot-loop with
# ERR_MODULE_NOT_FOUND if it's missing).
COPY --from=build --chown=cascade:cascade /repo/cloud/server/dist/index.js ./cloud/server/dist/index.js
COPY --from=build --chown=cascade:cascade /repo/cloud/server/vendor ./cloud/server/vendor
COPY --from=build --chown=cascade:cascade /repo/cloud/server/package.json ./cloud/server/package.json

# The built web SPA — cloud/server serves this directory statically
# (express.static + SPA fallback) whenever it exists on disk.
COPY --from=build --chown=cascade:cascade /repo/cloud/web/dist ./cloud/web/dist

# DATA_DIR mount point (SQLite DB + per-tenant uploads — see env.ts and
# docker-compose.yml, which mounts a named volume here). Created + chowned
# ahead of time so a fresh named volume docker-compose mounts over this path
# inherits the right ownership instead of ending up root-owned and
# unwritable by the non-root user below.
RUN mkdir -p /data && chown -R cascade:cascade /data

WORKDIR /repo/cloud/server
USER cascade

EXPOSE 8787

# Hits the server's real health endpoint (app.ts: `app.get('/health', ...)`).
# Uses Node's built-in fetch instead of curl/wget so the runtime image
# doesn't need either installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
