/**
 * Wire-safe type surface of the auth seam: the branded ids, the stored-user
 * and session record shapes, the decision and error vocabularies, and the
 * seam's Cordis event declarations. Types only — no runtime code, and nothing
 * here reaches a Host-only symbol, so a Client compilation face reads exactly
 * the signature the Host emits.
 *
 * @module @deepseek-ai/dsh-auth/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Nominal handle to one auth user (session and user-store records key on it). */
export type UserId = Branded<'UserId'>

/**
 * Nominal SHA-256 digest of a session token. The raw bearer token is never
 * stored or logged; only this hash crosses the session-store and event
 * boundaries, so a leaked store or event payload cannot be replayed.
 */
export type SessionTokenHash = Branded<'SessionTokenHash'>

/** Public view of one user: identity, handle, and role — never the password hash. */
export interface User {
  /** Opaque, stable handle to the user. */
  readonly id: UserId
  /** Unique login handle. */
  readonly username: string
  /** Authorization role (e.g. `admin`, `user`); flattened for {@link requireRole}. */
  readonly role: string
}

/** Public enumeration entry for one user, identical to {@link User} minus no secrets. */
export type UserSummary = User

/**
 * The durable user-store record. `passwordHash` is the `salt:hash` hex form
 * produced by `crypto.scrypt` and is never exposed through the public surface.
 */
export interface StoredUser extends User {
  /** `scrypt(salt, password)` hex, stored as `<salt>:<hash>` with a per-user salt. */
  readonly passwordHash: string
}

/** One durable session row in the SQLite session store. */
export interface SessionRecord {
  /** SHA-256 of the minted token, the store's primary key. */
  readonly tokenHash: SessionTokenHash
  /** Owner of the session. */
  readonly userId: UserId
  /** Creation time, epoch millis. */
  readonly createdAt: number
  /** Absolute expiry, epoch millis; a session past this is reaped on read. */
  readonly expiresAt: number
  /** Last successful {@link AuthService.verify} touch, epoch millis. */
  readonly lastSeenAt: number
}

/**
 * Result of an {@link AuthService.guard} decision made before a route owns the
 * request: `{ ok: true }` admits it, `{ ok: false }` rejects it with the HTTP
 * status the caller should surface (401 unauthenticated, 403 forbidden).
 */
export type AuthDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string }

/** Closed failure codes an {@link AuthService.login} or user-management call can produce. */
export type AuthErrorCode =
  /** Username/password pair did not match; never reveals which half. */
  | 'invalid-credentials'
  /** Too many failed attempts for the username/ip key; currently locked out. */
  | 'rate-limited'
  /** The named user does not exist. */
  | 'user-not-found'
  /** A user with the handle already exists. */
  | 'username-taken'
  /** The caller is not admitted by the guard and asked for a protected resource. */
  | 'unauthorized'

/** One structured auth failure. */
export interface AuthError {
  /** Stable machine-readable code. */
  readonly code: AuthErrorCode
  /** Human-readable message, safe to surface; never contains a secret. */
  readonly message: string
}

/** Credentials offered to {@link AuthService.login}. */
export interface LoginRequest {
  /** Login handle. */
  readonly username: string
  /** Cleartext password, hashed by scrypt on the way in. */
  readonly password: string
  /**
   * Peer address for the per-username+ip attempt counter. The HTTP layer
   * supplies it from the socket; absent, the counter keys on username alone.
   */
  readonly ip?: string
}

/** Successful {@link AuthService.login} result: the minted bearer/session token. */
export interface LoginResult {
  /** Random 32-byte hex bearer token (also the cookie value). */
  readonly token: string
}

/**
 * Header bag read by the guard's credential extraction. Callers pass the
 * request headers case-insensitively by name; array values use their first
 * element, V8-internal lowercasing is not assumed.
 */
export interface Headers {
  [name: string]: string | readonly string[] | undefined
}

/**
 * The inbound HTTP request a route owner asks {@link AuthService.guard} about.
 * Only the header bag is read; `method` and `url` are carried for richer
 * future decisions (e.g. exempting a public route) without widening the seam.
 */
export interface AuthRequest {
  /** The request's headers. */
  readonly headers: Headers
  /** Optional HTTP method, for future route-level exemptions. */
  readonly method?: string
  /** Optional request target, for future route-level exemptions. */
  readonly url?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A session row committed (login issued it). Fires after the write, so a
     * broken observer can never make a committed login look failed; the
     * payload carries the token hash only, never the raw token.
     * @param record - the committed session hash and its owner.
     * @mode emit
     */
    'auth/session-issued'(record: { readonly tokenHash: SessionTokenHash; readonly userId: UserId }): void

    /**
     * A session row was removed (logout, or an expired session reaped on
     * read). Fires after the removal, on the same payload rule.
     * @param record - the removed session hash.
     * @mode emit
     */
    'auth/session-revoked'(record: { readonly tokenHash: SessionTokenHash }): void
  }
}
