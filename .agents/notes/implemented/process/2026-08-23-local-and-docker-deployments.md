# Agent Note: Two deployments from one tree — local without login, Docker behind Caddy with it

Status: implemented

English | [中文](2026-08-23-local-and-docker-deployments.zh.md)

## Problem

The fork serves two audiences from one checkout: the workstation run (`dsh web`, bound to loopback, used while developing) and a container published on the host network through Caddy. The login surface added with `@deepseek-ai/dsh-auth` was composed by the web bundle itself, which made every deployment session-required: the local run demanded a password too, and with no account in `$DSH_HOME/auth/users.json` the guard answered 401 to everything — including the GUI — with no registration route and no command-line way to create the first user.

## Decision

The shipped web profile composes **no auth row**: `packages/bundle/web-app/cordis.patch.yml` keeps the local deployment unauthenticated, so `dsh web` on a workstation opens straight onto the conversation and the trust fence remains the whole gate. The auth row is a deployment overlay instead — `deploy/auth.patch.yml`, applied with `dsh web --patch <file>` — and the Docker image is the only composer of it (Dockerfile CMD), because Caddy publishes that container beyond loopback.

`--patch` must precede the web app's own flags on the command line: the `web` alias passes unknown options through to the app's parser once one appears, and the app does not know `--patch`. The image therefore runs `dsh web --patch /app/deploy/auth.patch.yml --host 127.0.0.1 --port 8081 --no-open`, and its healthcheck probes `/login` (200 without a session) rather than `/` (302 to the login page).

`deploy/auth-add-user.mjs` bootstraps an account without adding CLI surface: it writes `$DSH_HOME/auth/users.json` with the same `scrypt(password, salt, 64)` `<saltHex>:<keyHex>` form the service verifies, prompting for the password or reading `DSH_AUTH_PASSWORD`. The auth service loads that store **at boot**, so an account created while a server is already running stays invisible until `docker compose restart dsh`; the documented flow creates the account first (`docker compose run --rm … dsh node deploy/auth-add-user.mjs <username>`), then boots.

The overlay stays one row plus its config: `trustedHosts` mirrors the connection row's authority list, and `cookieSecure: false` matches the plain-HTTP local compose file (a TLS deployment sets it true).

## Alternatives considered

**Leave the auth row in the bundle and disable it for local runs.** One artifact with an env-gated `disabled` keeps the two modes a single file apart. It also makes an unauthenticated mode the default outcome of an unset variable, which is the wrong failure direction for a surface that can be published; the overlay makes each mode state its own posture.

**Require auth everywhere, including the workstation.** One code path and one mental model. It costs the local loop its zero-friction property (a login every 8 hours on a machine the user already unlocked) for a threat that the loopback bind already excludes.

**Seed the first account from compose environment variables at container start.** `docker compose up` alone would then produce a usable login. It puts a cleartext password in the compose file or the shell history of every start, and hides account creation inside the entrypoint; an explicit one-shot command keeps the secret out of the long-lived configuration.

**Add a `dsh auth user add` CLI command.** The idiomatic home for account management. It needs a new command surface, its own tests, and a loader boot inside the command; the helper script reaches the same file with no new public surface, and the service API (`userAdd`) remains the in-process path for plugins.

## Consequences

One commit deploys both ways: the workstation keeps the unauthenticated loopback GUI, and the container is session-required end to end — `/` redirects to the French login page, `/api/auth/me` answers the user, and every `/api` route (including the composer's `/api/workspace-file` upload) answers 401 without the session cookie. Verified in both directions: locally `/` returned 200 with no redirect and `/api/auth/me` 404; through Caddy `/` returned 302 to `/login`, an unauthenticated upload returned 401, and a session cookie returned the GUI and the user.

Account management stays file-first on the container: adding or changing an account requires the helper plus a container restart, and a deployment that edits `users.json` by hand must match the hash format or logins fail with an indistinguishable "invalid credentials". A public deployment additionally needs `--trusted-host <authority>` (the fence accepts only loopback authorities otherwise) and `cookieSecure: true`.
