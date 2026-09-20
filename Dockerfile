# syntax=docker/dockerfile:1

# Caddy binary source (build stage only): the runtime reverse proxy.
FROM caddy:2.8 AS caddy

# ── Build stage: install deps and build the whole workspace ─────────────────
# Node 24 satisfies the repo engine (^22.19 || >=24). corepack pins pnpm from
# the "packageManager" field in package.json (@11.7.0).
FROM node:24-bookworm-slim AS build

RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Do not install git hooks on the ephemeral checkout (lefthook's postinstall).
# Raise the Node heap: `tsc -b` on the host aggregate exceeds the default ~2 GiB
# cap, and this image runs inside a small Docker Desktop VM (~3.8 GiB). 3072 MiB
# stays under the VM limit while giving the compiler room to finish.
ENV LEFTHOOK=0 \
    NODE_OPTIONS=--max-old-space-size=3072

WORKDIR /app

# Dependency layer (cached until these change). pnpm install --frozen-lockfile
# needs the full workspace present: vendor/*, packages/*/*, native/landlock-run,
# apps/*, website, examples, python/sdk-runtime. The COPY below brings the
# source tree (derived outputs are excluded by .dockerignore), so this step
# reinstalls and rebuilds from source — the image never inherits host artifacts.
COPY . .

RUN pnpm install --frozen-lockfile

# Build every package's lib/ and the Web frontend dist (apps/web/dist). The
# running `dsh` CLI resolves the frontend dist through
# require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'), so both the
# workspace node_modules links and the built dist are needed at runtime.
RUN pnpm run build

# ── Runtime stage: thin image, no build toolchain ───────────────────────────
# DSH binds only 127.0.0.1 (the repo rejects `--host 0.0.0.0` until an auth
# layer exists), so Caddy runs in this same container: it binds 0.0.0.0:3081
# (the user-chosen published port) and forwards to DSH's internal loopback
# 127.0.0.1:8081. This same-container layout is the Phase-4 deployment model
# (Caddy then terminates TLS/Let's Encrypt).
FROM node:24-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash dsh \
  && mkdir -p /data/.dsh /workspace \
  && chown -R dsh:dsh /data /workspace

# Caddy reverse proxy binary from the caddy build stage. The Caddyfile lives in
# the repo and reaches /app/Caddyfile via the workspace COPY below, so it is
# owned by `dsh` and readable by Caddy (no separate /etc/caddy copy).
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy

WORKDIR /app

# Copy the built workspace (node_modules with its pnpm workspace links, all
# lib/, apps/web/dist, apps/cli/lib/bin.js). Same /app path as the build stage
# so the pnpm symlinks resolve identically.
COPY --from=build --chown=dsh:dsh /app /app

# User data home (sessions, storages, settings, presets, profiles) and Caddy
# state; a volume is mounted here in compose. All must stay writable by `dsh`.
ENV DSH_HOME=/data/.dsh \
    XDG_CONFIG_HOME=/data/.dsh/caddy \
    XDG_DATA_HOME=/data/.dsh/caddy/pki \
    XDG_CACHE_HOME=/data/.dsh/caddy/cache \
    NODE_ENV=production \
    DSH_TELEMETRY_DISABLED=1

USER dsh

# The externally published container port (user-chosen). DSH itself listens on
# loopback:8081, and Caddy fronts 0.0.0.0:3081.
EXPOSE 3081

# Healthcheck: Caddy answers 200 at "/" (unauth still 200 in Phase 0).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3081/ >/dev/null || exit 1

# tini reaps DSH's orphaned backgrounded children; Caddy is the foreground PID.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bin/sh", "-c", "node apps/cli/lib/bin.js web --host 127.0.0.1 --port 8081 --no-open & exec caddy run --config /app/Caddyfile --adapter caddyfile"]
