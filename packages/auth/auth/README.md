# @deepseek-ai/dsh-auth

English | [中文](README.zh.md)

Authentication seam (`ctx.auth`) for the DeepSeek Harness web server. It supplies the credential check a route owner applies **before** serving, and — when a `webServer` is composed — self-registers the `/api/auth/login`, `/api/auth/logout`, and `/api/auth/me` routes. The `/api` bridge and the surface fallback keep the reachability trust fence and additionally require a valid session whenever this seam is composed; absent it, the Web server runs the unauthenticated loopback behavior.

- `guard(req)` decides admission — `{ ok: true }` or `{ ok: false, status, reason }` — from the bearer token or the configured session cookie.
- `login({ username, password, ip? })` verifies a password against a JSON user store, mints a session, and returns the token.
- `logout(token)`, `verify(token)`, `me(headers)` manage and read sessions.
- `userList`, `userAdd`, `userRemove`, `userChangePassword` manage the user store.
- `requireRole(...roles)` builds a role predicate for route owners.

## Design

Passwords are hashed with `crypto.scrypt` (no argon2/bcrypt dependency) using a random per-user salt, stored as hex `salt:hash`, and compared with `crypto.timingSafeEqual`. Nothing in the seam returns or logs a raw password or session token; the session store keys on the **SHA-256 digest** of the token, so a leaked store or event payload cannot be replayed.

Users live in a JSON file under `$DSH_HOME` (`auth/users.json` by default). Sessions live in a SQLite database via Node's built-in `node:sqlite` (`auth/sessions.sqlite` by default), with `tokenHash` as the primary key, plus `userId`, `createdAt`, `expiresAt`, and `lastSeenAt`. Expired rows are reaped on read.

Credentials are accepted as either an `Authorization: Bearer <token>` header or an HttpOnly `dsh_session` cookie (override `cookieName`). The self-registered `login` route writes that cookie from the token `login` returns, using `cookieSecure` and `cookieSameSite`; the guard and `me` read it back.

Login is rate-limited per `username+ip` with an in-memory counter: after `maxAttempts` failures the key locks for `lockoutMs`. An unknown user still runs the scrypt cost (a fixed dummy salt) so a timing difference cannot be used to enumerate usernames, and both wrong-password and unknown-user failures return the identical generic message.

## Surface

```ts
import type { Context } from '@deepseek-ai/cordis'
import AuthService from '@deepseek-ai/dsh-auth'

declare const ctx: Context

const decision = ctx.auth.guard({ headers: reqHeaders })          // { ok: true } | { ok: false, status, reason }
const login = await ctx.auth.login({ username, password, ip })    // { token } | { code, message }
ctx.auth.logout(token)
const user = ctx.auth.verify(token)                              // User | null
const me = ctx.auth.me(reqHeaders)                                // User | null

ctx.auth.userList()          // UserSummary[]
await ctx.auth.userAdd({ username, password, role? })  // UserSummary (rejects username-taken)
ctx.auth.userRemove(username)                    // boolean
await ctx.auth.userChangePassword(username, password)  // rejects user-not-found

const isAdmin = ctx.auth.requireRole('admin')    // (user: User) => boolean
```

`guard` is the admission gate; role enforcement is a separate `requireRole(...)` predicate a route owner applies to the verified user.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Whether `guard` enforces authentication; `false` admits every request (the reachability trust fence is then the only gate). |
| `sessionTtlMs` | `8h` | Session lifetime. |
| `cookieName` | `dsh_session` | Cookie name read by the guard and set by the HTTP layer. |
| `cookieSecure` | `false` | `Secure` attribute on the session cookie (set false for local HTTP). |
| `cookieSameSite` | `Strict` | SameSite attribute on the session cookie. |
| `maxAttempts` | `5` | Failed attempts before a `username+ip` lockout. |
| `lockoutMs` | `15m` | Lockout duration. |
| `usersFile` | `$DSH_HOME/auth/users.json` | User-store JSON path. |
| `sessionsFile` | `$DSH_HOME/auth/sessions.sqlite` | SQLite session path. |
| `role` | `user` | Role assigned to users added without an explicit role. |
| `trustedHosts` | `[]` | Non-loopback authorities (exact `host:port` or port-less `host`) the self-registered `/api/auth/*` routes accept in their Host/Origin fence; empty = loopback only. |

Config is validated by a schemastery `z.object`; an invalid deployment fails loud at load.

## HTTP routes

When a `webServer` is composed, the seam registers three exact-path routes that win over the `/api` prefix and apply the same Host/Origin fence as the `/api` bridge (`trustedHosts`, default loopback):

- `POST /api/auth/login` — body `{ username, password }`; success sets the session cookie and returns `{ ok: true, user }`, failure answers `401` with a `retry-after` hint.
- `POST /api/auth/logout` — revokes the presenting session and clears the session cookie.
- `GET /api/auth/me` — returns `{ user }`, or `401` when no session is presented.

## Model Experience

None, as this host-side seam is not yet used by any model-visible surface.

#### KV Cache effect

No invalidation; auth never enters a request prefix.

## Known Limitations and Deferred Work

- **Cookie setting lives in the self-registered routes** — `login` returns the token and the guard reads cookies; the seam's own `/api/auth/login` route writes the HttpOnly `dsh_session` cookie from it. A custom route owner wanting to set the cookie repeats the same `cookieName`/`cookieSecure`/`cookieSameSite` attributes.
- **In-memory rate limiter is per process** — the `username+ip` attempt counter and lockout do not survive a restart or span multiple server instances; a distributed limiter is deferred.
- **Sessions are not invalidated on password change or user removal** — `userChangePassword` and `userRemove` modify only the user store; existing sessions for that user remain valid until their expiry (a `logout` by the client, or an explicit future revocation API, is deferred). This is a deliberate scope limit, not an oversight of the hashing path.
- **No CSRF token for cookie-authenticated forms** — the guard accepts cookie credentials as-is; cookie-carrying cross-site requests are left to the operator's `cookieSameSite`/Origin policy. A per-session CSRF token is deferred.
- **No role-based route policy built in** — `requireRole` is a predicate; declaring which path needs which role lives with the route owner.
- **No boot-level seed user** — the store starts empty; an operator must create the first user (e.g. `userAdd`) before anyone can log in.
- **JSON user file is not migration-versioned** — the store is a flat array; a future schema change needs a compat/migration step.
