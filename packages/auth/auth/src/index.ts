/**
 * Service Definition for the authentication capability seam (`ctx.auth`) of the
 * DeepSeek Harness web server. It owns password hashing (scrypt, constant-time
 * compare), a JSON user store under `$DSH_HOME`, SQLite-backed sessions, bearer
 * and HttpOnly-cookie credentials, per-username+ip attempt limiting, and the
 * `guard` decision route owners call before serving. When a `webServer` is
 * composed it also self-registers the `/api/auth/login`, `/api/auth/logout`,
 * and `/api/auth/me` routes (applying the same Host/Origin fence as the `/api`
 * bridge); without a `webServer` the service remains usable as a bare seam.
 * @module @deepseek-ai/dsh-auth
 */

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { assertTrustedAuthority, isTrustedApiRequest } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {
  AuthDecision,
  AuthError,
  AuthRequest,
  Headers,
  LoginRequest,
  LoginResult,
  SessionRecord,
  SessionTokenHash,
  StoredUser,
  User,
  UserId,
  UserSummary,
} from './types.ts'

export type {
  AuthDecision,
  AuthError,
  AuthErrorCode,
  AuthRequest,
  Headers,
  LoginRequest,
  LoginResult,
  SessionRecord,
  SessionTokenHash,
  StoredUser,
  User,
  UserId,
  UserSummary,
} from './types.ts'

/** scrypt salt length, bytes. */
const SALT_BYTES = 16
/** Derived key length, bytes. */
const KEY_LENGTH = 64
/** Random session token length, bytes. */
const TOKEN_BYTES = 32
/** Fixed salt for the unknown-user timing equalization path. */
const DUMMY_SALT = '00000000000000000000000000000000'

/** Brand a raw string as a {@link UserId}. */
function userId(value: string): UserId {
  return value as UserId
}

/** Brand a SHA-256 digest as a {@link SessionTokenHash}. */
function sessionTokenHash(value: string): SessionTokenHash {
  return value as SessionTokenHash
}

/** Derive an scrypt key asynchronously (non-blocking, for the server loop). */
function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (error, derived) => {
      if (error !== null) reject(error)
      else resolve(derived)
    })
  })
}

/** Hash a cleartext password to `<salt>:<hash>` hex with a random per-user salt. */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString('hex')
  const key = await deriveKey(password, salt)
  return `${salt}:${key.toString('hex')}`
}

/**
 * Whether a cleartext password matches a stored `<salt>:<hash>` value.
 * Compares with `timingSafeEqual` on equal-length buffers so a length mismatch
 * does not leak through an early return; the caller equalizes the unknown-user
 * path's scrypt cost before arriving here for the real user.
 */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':')
  if (salt === undefined || hash === undefined) return false
  const derived = await deriveKey(password, salt)
  const expected = Buffer.from(hash, 'hex')
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

/** SHA-256 digest of a raw session token, the store's opaque key. */
function digestToken(token: string): SessionTokenHash {
  return sessionTokenHash(createHash('sha256').update(token).digest('hex'))
}

/** Case-insensitive first-value header read. */
function headerValue(headers: Headers, name: string): string | undefined {
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name)
  if (key === undefined) return undefined
  const value = headers[key]
  if (Array.isArray(value)) return value[0] as string | undefined
  return typeof value === 'string' ? value : undefined
}

/** Read the whole request body as a UTF-8 string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/** Write a JSON response with the given status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Serialize a session-cookie Set-Cookie header value. */
function sessionSetCookie(config: ResolvedConfig, value: string, maxAge?: number): string {
  const parts = [`${config.cookieName}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${config.cookieSameSite}`]
  if (config.cookieSecure) parts.push('Secure')
  if (maxAge !== undefined) parts.push(`Max-Age=${String(maxAge)}`)
  return parts.join('; ')
}

/** Set the session cookie on a successful login response. */
function writeSessionCookie(res: ServerResponse, config: ResolvedConfig, token: string): void {
  res.setHeader('Set-Cookie', sessionSetCookie(config, token))
}

/** Clear the session cookie on logout. */
function clearSessionCookie(res: ServerResponse, config: ResolvedConfig): void {
  res.setHeader('Set-Cookie', sessionSetCookie(config, '', 0))
}

/** Extract the bearer or configured-cookie token from an inbound request. */
function requestToken(req: IncomingMessage, cookieName: string): string | undefined {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const trimmed = authorization.trim()
    if (trimmed.startsWith('Bearer ')) {
      const token = trimmed.slice('Bearer '.length).trim()
      if (token.length > 0) return token
    }
  }
  const cookie = req.headers.cookie
  if (typeof cookie !== 'string') return undefined
  for (const part of cookie.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === cookieName) return part.slice(eq + 1).trim()
  }
  return undefined
}

/** Strip the password hash from a stored record for the public surface. */
function publicView(user: StoredUser): UserSummary {
  return { id: user.id, username: user.username, role: user.role }
}

/** Plugin config; every field optional and validated by the `static Config` schema. */
export interface Config {
  /**
   * Whether the guard enforces authentication; `false` lets every request pass
   * (the reachability trust fence is then the only gate). Default `true`.
   */
  readonly enabled?: boolean
  /** Session lifetime, millis. Default 8h. */
  readonly sessionTtlMs?: number
  /** Cookie name used by the (HTTP-layer) login response and read by the guard. Default `dsh_session`. */
  readonly cookieName?: string
  /** Whether the session cookie carries the `Secure` attribute. Default `false` (local HTTP). */
  readonly cookieSecure?: boolean
  /** SameSite attribute for the session cookie. Default `Strict`. */
  readonly cookieSameSite?: 'Strict' | 'Lax' | 'None'
  /** Failed attempts before a username+ip lockout. Default 5. */
  readonly maxAttempts?: number
  /** Lockout duration after exceeding `maxAttempts`, millis. Default 15m. */
  readonly lockoutMs?: number
  /** Users-JSON path; defaults to `$DSH_HOME/auth/users.json`. */
  readonly usersFile?: string
  /** SQLite sessions path; defaults to `$DSH_HOME/auth/sessions.sqlite`. */
  readonly sessionsFile?: string
  /** Role assigned to users added without an explicit role. Default `user`. */
  readonly role?: string
  /**
   * Non-loopback authorities the self-registered `/api/auth/*` routes accept in
   * their Host/Origin fence, exactly as the `/api` trust fence does: exact
   * `host:port` or port-less `host`. Default `[]` (loopback only). An entry that
   * is not a bare, canonical authority fails the plugin load.
   */
  readonly trustedHosts?: string[]
}

/** Config after schema validation: the defaulted fields are always present. */
interface ResolvedConfig {
  readonly enabled: boolean
  readonly sessionTtlMs: number
  readonly cookieName: string
  readonly cookieSecure: boolean
  readonly cookieSameSite: 'Strict' | 'Lax' | 'None'
  readonly maxAttempts: number
  readonly lockoutMs: number
  readonly role: string
  readonly usersFile?: string
  readonly sessionsFile?: string
  readonly trustedHosts: string[]
}

interface AttemptState {
  count: number
  lockedUntil: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    auth: AuthService
  }
}

/**
 * Auth service: decides admission, verifies credentials, and manages users and
 * sessions. Every failure code and decision reason is safe to surface; no code
 * path returns or logs a raw password or session token.
 */
export class AuthService extends Service {
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(true),
    sessionTtlMs: z.number().min(1).default(8 * 60 * 60 * 1000),
    cookieName: z.string().min(1).default('dsh_session'),
    cookieSecure: z.boolean().default(false),
    cookieSameSite: z.union(['Strict', 'Lax', 'None']).default('Strict'),
    maxAttempts: z.number().min(1).default(5),
    lockoutMs: z.number().min(1).default(15 * 60 * 1000),
    usersFile: z.string(),
    sessionsFile: z.string(),
    role: z.string().min(1).default('user'),
    trustedHosts: z.array(String).default([]),
  })

  private readonly config: ResolvedConfig
  private readonly defaultRole: string
  private readonly usersPath: string
  private readonly sessionsPath: string
  private readonly db: DatabaseSync
  private users: StoredUser[]
  private readonly attempts = new Map<string, AttemptState>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'auth')
    // The schema validates and applies every `.default(...)`; the cast only
    // narrows the optional-input TYPE for the always-defaulted fields (the
    // config validation boundary is the single place this trust is placed).
    this.config = AuthService.Config(config) as ResolvedConfig
    this.defaultRole = this.config.role
    this.usersPath = this.config.usersFile ?? dshHomePath('auth', 'users.json')
    this.sessionsPath = this.config.sessionsFile ?? dshHomePath('auth', 'sessions.sqlite')
    this.users = this.loadUsers()
    this.db = this.openSessions()
    this.pruneExpired()
    // Config boundary: a malformed trustedHosts entry fails the load loudly
    // here rather than silently authorizing its hostname prefix at request time.
    for (const entry of this.config.trustedHosts) assertTrustedAuthority(entry)
    // Self-register the login/logout/me routes on the webServer when one is
    // composed. The auth service stays usable without a webServer (bare tests,
    // non-HTTP embedding), so this is a soft deferred inject, not a hard one.
    this.registerHttpRoutes()
  }

  /**
   * Decide whether an inbound HTTP request may pass. With auth disabled
   * (`enabled: false`) every request is admitted; otherwise a missing or
   * invalid bearer/cookie credential yields 401.
   * @param req - the inbound request (headers are read).
   * @returns `{ ok: true }` to admit, or `{ ok: false, status, reason }` to reject.
   */
  guard(req: AuthRequest): AuthDecision {
    if (!this.config.enabled) return { ok: true }
    const token = this.tokenFrom(req.headers)
    if (token === undefined) {
      return { ok: false, status: 401, reason: 'no session credential presented' }
    }
    const user = this.verify(token)
    if (user === null) {
      return { ok: false, status: 401, reason: 'session is invalid or expired' }
    }
    return { ok: true }
  }

  /**
   * Verify a username/password pair, mint a session, and return its token.
   * Returns an {@link AuthError} value (never throws) on failure. The
   * per-username+ip attempt counter locks the key after `maxAttempts` failures
   * for `lockoutMs`. An unknown user runs the same scrypt as a real one to
   * avoid a timing username oracle, and both wrong-password and unknown-user
   * failures report the same generic message.
   * @param req - the credentials and optional peer address.
   * @returns `{ token }` on success, or an {@link AuthError} on failure.
   */
  async login(req: LoginRequest): Promise<LoginResult | AuthError> {
    const key = `${req.username}:${req.ip ?? 'unknown'}`
    const lock = this.attempts.get(key)
    if (lock !== undefined && lock.lockedUntil > Date.now()) {
      return { code: 'rate-limited', message: 'too many failed attempts; try again later' }
    }

    const user = this.userByUsername(req.username)
    if (user === undefined) {
      await deriveKey(req.password, DUMMY_SALT)
      this.recordFailure(key)
      return { code: 'invalid-credentials', message: 'invalid username or password' }
    }
    if (!await verifyPassword(req.password, user.passwordHash)) {
      this.recordFailure(key)
      return { code: 'invalid-credentials', message: 'invalid username or password' }
    }

    this.attempts.delete(key)
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    const tokenHash = digestToken(token)
    const now = Date.now()
    const record: SessionRecord = {
      tokenHash,
      userId: user.id,
      createdAt: now,
      expiresAt: now + this.config.sessionTtlMs,
      lastSeenAt: now,
    }
    this.insertSession(record)
    this.notify('auth/session-issued', { tokenHash, userId: user.id })
    return { token }
  }

  /**
   * Revoke a session by its bearer/cookie token. Removing an absent token is a
   * no-op; a previously-revoked or expired token is silent.
   * @param token - the raw token to revoke.
   */
  logout(token: string): void {
    const tokenHash = digestToken(token)
    if (this.deleteSession(tokenHash)) {
      this.notify('auth/session-revoked', { tokenHash })
    }
  }

  /**
   * Validate a bearer token or decoded session-cookie value. Expired sessions
   * are reaped (their row removed) and report `null`; a live session is
   * touched for `lastSeenAt`.
   * @param token - the raw token value.
   * @returns the owning user, or `null` when absent, expired, or invalid.
   */
  verify(token: string): User | null {
    if (token.length === 0) return null
    const tokenHash = digestToken(token)
    const record = this.sessionRecord(tokenHash)
    if (record === undefined) return null
    const now = Date.now()
    if (record.expiresAt <= now) {
      this.deleteSession(tokenHash)
      this.notify('auth/session-revoked', { tokenHash })
      return null
    }
    this.touchSession(tokenHash, now)
    const user = this.userById(record.userId)
    return user === undefined ? null : publicView(user)
  }

  /**
   * Resolve the user presenting `headers` (bearer or the configured cookie),
   * or `null` when none or invalid.
   * @param headers - the request headers.
   * @returns the presenting user, or `null`.
   */
  me(headers: Headers): User | null {
    const token = this.tokenFrom(headers)
    if (token === undefined) return null
    return this.verify(token)
  }

  /**
   * Enumerate every user, secrets excluded.
   * @returns all users as {@link UserSummary}.
   */
  userList(): UserSummary[] {
    return this.users.map(publicView)
  }

  /**
   * Create a user. Throws {@link AuthError} (`username-taken`) when the handle
   * already exists.
   * @param req - the new user's handle, password, and optional role.
   * @returns the created user, secrets excluded.
   */
  async userAdd(req: { username: string; password: string; role?: string }): Promise<UserSummary> {
    if (this.userByUsername(req.username) !== undefined) {
      throw new AuthFailure('username-taken', `user "${req.username}" already exists`)
    }
    const user: StoredUser = {
      id: userId(randomUUID()),
      username: req.username,
      passwordHash: await hashPassword(req.password),
      role: req.role ?? this.defaultRole,
    }
    this.users = [...this.users, user]
    this.saveUsers()
    return publicView(user)
  }

  /**
   * Remove a user by handle; removing an absent user is a no-op.
   * @param username - the handle to remove.
   * @returns whether a user was removed.
   */
  userRemove(username: string): boolean {
    const before = this.users.length
    this.users = this.users.filter(user => user.username !== username)
    const removed = this.users.length !== before
    if (removed) this.saveUsers()
    return removed
  }

  /**
   * Replace a user's password. Throws {@link AuthError} (`user-not-found`)
   * when the handle does not exist.
   * @param username - the handle to update.
   * @param password - the new cleartext password, re-hashed with a fresh salt.
   */
  async userChangePassword(username: string, password: string): Promise<void> {
    const index = this.users.findIndex(user => user.username === username)
    if (index < 0) throw new AuthFailure('user-not-found', `user "${username}" does not exist`)
    const current = this.users[index] as StoredUser
    const next = [...this.users]
    next[index] = { ...current, passwordHash: await hashPassword(password) }
    this.users = next
    this.saveUsers()
  }

  /**
   * Build a predicate that admits a user carrying any of `roles`. Route owners
   * apply it to the {@link User} a successful {@link guard} returned.
   * @param roles - the roles that satisfy the gate.
   * @returns a predicate true when the user's role is among `roles`.
   */
  requireRole(...roles: string[]): (user: User) => boolean {
    return (user: User) => roles.includes(user.role)
  }

  /**
   * Register the self-contained login/logout/me HTTP routes on the composed
   * webServer. The registration is a soft deferred inject, so the auth service
   * stays usable without a webServer (bare service tests, non-HTTP embedding):
   * when one is composed the routes win over the `/api` prefix because they are
   * exact-path registrations. Each route applies the same Host/Origin fence as
   * the `/api` bridge, so a rebound or cross-site request never reaches the
   * credential surface.
   */
  private registerHttpRoutes(): void {
    this.ctx.inject(['webServer'], (webCtx) => {
      const register = (path: string, handler: WebRoute['handler']): void => {
        webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler }), `auth: ${path}`)
      }
      register('/api/auth/login', (req, res) => this.handleLogin(req, res))
      register('/api/auth/logout', (req, res) => this.handleLogout(req, res))
      register('/api/auth/me', (req, res) => this.handleMe(req, res))
    })
  }

  /**
   * `POST /api/auth/login` route: verify credentials, mint a session, and set
   * the HttpOnly session cookie. Failures answer 401 without revealing which
   * credential half was wrong; the AuthService's own attempt limiter supplies
   * the lockout, and the response hints a retry interval.
   * @param req - the inbound request.
   * @param res - the response to write.
   */
  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedApiRequest(req, this.config.trustedHosts)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    let body: Record<string, unknown>
    try {
      const parsed = JSON.parse(await readBody(req)) as unknown
      if (typeof parsed !== 'object' || parsed === null) throw new Error('body must be an object')
      body = parsed as Record<string, unknown>
    } catch {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    const username = typeof body['username'] === 'string' ? body['username'] : ''
    const password = typeof body['password'] === 'string' ? body['password'] : ''
    const ip = req.socket.remoteAddress
    const result = await this.login(ip === undefined
      ? { username, password }
      : { username, password, ip })
    if ('token' in result) {
      writeSessionCookie(res, this.config, result.token)
      const user = this.verify(result.token)
      sendJson(res, 200, { ok: true, user })
      return
    }
    res.writeHead(401, { 'content-type': 'application/json', 'retry-after': '60' })
    res.end(JSON.stringify({ ok: false, error: result }))
  }

  /**
   * `POST /api/auth/logout` route: revoke the presenting session and clear the
   * session cookie. Revoking an absent token is a no-op; the response is always
   * an explicit success so a stale cookie does not surface an error.
   * @param req - the inbound request.
   * @param res - the response to write.
   */
  private async handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedApiRequest(req, this.config.trustedHosts)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const token = requestToken(req, this.config.cookieName)
    if (token !== undefined) this.logout(token)
    clearSessionCookie(res, this.config)
    sendJson(res, 200, { ok: true })
  }

  /**
   * `GET /api/auth/me` route: resolve the presenting session's user, or 401.
   * @param req - the inbound request.
   * @param res - the response to write.
   */
  private async handleMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedApiRequest(req, this.config.trustedHosts)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405)
      res.end()
      return
    }
    const user = this.me(req.headers)
    if (user === null) {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    sendJson(res, 200, { user })
  }

  /** Read the bearer or configured-cookie token from a header bag. */
  private tokenFrom(headers: Headers): string | undefined {
    const authorization = headerValue(headers, 'authorization')
    if (authorization !== undefined) {
      const trimmed = authorization.trim()
      if (trimmed.startsWith('Bearer ')) {
        const token = trimmed.slice('Bearer '.length).trim()
        if (token.length > 0) return token
      }
    }
    const cookie = headerValue(headers, 'cookie')
    if (cookie === undefined) return undefined
    const name = this.config.cookieName
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
    }
    return undefined
  }

  /** Load the JSON user store; an absent file is an empty store. */
  private loadUsers(): StoredUser[] {
    if (!existsSync(this.usersPath)) return []
    const parsed = JSON.parse(readFileSync(this.usersPath, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isStoredUser).map(toStoredUser)
  }

  /** Persist the JSON user store through a same-directory temp + rename. */
  private saveUsers(): void {
    mkdirSync(dirname(this.usersPath), { recursive: true })
    const tmp = `${this.usersPath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.users, null, 2))
    renameSync(tmp, this.usersPath)
  }

  /** Open the SQLite session store, creating the schema if absent. */
  private openSessions(): DatabaseSync {
    mkdirSync(dirname(this.sessionsPath), { recursive: true })
    const db = new DatabaseSync(this.sessionsPath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        tokenHash TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        lastSeenAt INTEGER NOT NULL
      )
    `)
    return db
  }

  /** Read one session row by hash. */
  private sessionRecord(tokenHash: SessionTokenHash): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE tokenHash = ?')
      .get(tokenHash) as SessionRow | undefined
    if (row === undefined) return undefined
    return {
      tokenHash: sessionTokenHash(row.tokenHash),
      userId: userId(row.userId),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastSeenAt: row.lastSeenAt,
    }
  }

  /** Insert one session row. */
  private insertSession(record: SessionRecord): void {
    this.db
      .prepare('INSERT INTO sessions (tokenHash, userId, createdAt, expiresAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)')
      .run(record.tokenHash, record.userId, record.createdAt, record.expiresAt, record.lastSeenAt)
  }

  /** Delete one session row; returns whether a row was removed. */
  private deleteSession(tokenHash: SessionTokenHash): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE tokenHash = ?').run(tokenHash).changes > 0
  }

  /** Advance a row's `lastSeenAt`. */
  private touchSession(tokenHash: SessionTokenHash, now: number): void {
    this.db.prepare('UPDATE sessions SET lastSeenAt = ? WHERE tokenHash = ?').run(now, tokenHash)
  }

  /** Remove every expired row, one delete at a time so each emits its event. */
  private pruneExpired(): void {
    const now = Date.now()
    const expired = this.db
      .prepare('SELECT tokenHash FROM sessions WHERE expiresAt <= ?')
      .all(now) as Array<{ tokenHash: string }>
    for (const row of expired) {
      if (this.deleteSession(sessionTokenHash(row.tokenHash))) {
        this.notify('auth/session-revoked', { tokenHash: sessionTokenHash(row.tokenHash) })
      }
    }
  }

  /** Look up a stored user by handle. */
  private userByUsername(username: string): StoredUser | undefined {
    return this.users.find(user => user.username === username)
  }

  /** Look up a stored user by id. */
  private userById(id: UserId): StoredUser | undefined {
    return this.users.find(user => user.id === id)
  }

  /** Increment the failure counter for a key, entering lockout at the threshold. */
  private recordFailure(key: string): void {
    const known = this.attempts.get(key)
    const count = (known?.count ?? 0) + 1
    this.attempts.set(key, count >= this.config.maxAttempts
      ? { count, lockedUntil: Date.now() + this.config.lockoutMs }
      : { count, lockedUntil: 0 })
  }

  /**
   * Fan a committed session event out with contained listener failures: every
   * listener runs, a sync throw or async rejection is logged without changing
   * the committed operation's outcome, except `INVARIANT`-coded failures,
   * which rethrow after every listener ran (that rethrow reaches the emitter
   * only from synchronous listeners, so invariant checks on this event must
   * not be async functions). Emitted only after the row committed or was
   * removed, so a broken observer can never make a durable change look failed.
   */
  private notify(event: 'auth/session-issued' | 'auth/session-revoked', subject: Record<string, unknown>): void {
    let invariantFailure: unknown
    const args = [event, subject]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(payload: Record<string, unknown>) => unknown>) {
      try {
        const returned = listener(subject)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListener(event, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListener(event, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListener(event: string, error: unknown): void {
    this.ctx.logger.warn('auth: a "%s" listener failed', event)
    this.ctx.logger.warn(error)
  }
}

/** A raw SQLite session row as returned by `SELECT *`. */
interface SessionRow {
  tokenHash: string
  userId: string
  createdAt: number
  expiresAt: number
  lastSeenAt: number
}

/** Whether an untrusted JSON value could be a stored user record. */
function isStoredUser(value: unknown): value is { id: string; username: string; passwordHash: string; role: string } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string'
    && typeof record['username'] === 'string'
    && typeof record['passwordHash'] === 'string'
    && typeof record['role'] === 'string'
}

/** Cast a validated record into a {@link StoredUser}. */
function toStoredUser(value: { id: string; username: string; passwordHash: string; role: string }): StoredUser {
  return {
    id: userId(value.id),
    username: value.username,
    passwordHash: value.passwordHash,
    role: value.role,
  }
}

/**
 * A thrown auth failure carrying a machine-readable `code`; structurally
 * satisfies the `./types` {@link AuthError} type. Kept local because `login`
 * reports failures as returned values (the {@link AuthError} shape) rather
 * than thrown ones; only the management methods throw.
 */
class AuthFailure extends Error {
  /** Stable machine-readable auth failure code. */
  readonly code: AuthError['code']

  /**
   * Construct an auth failure.
   * @param code - the stable failure code.
   * @param message - human-readable, secret-free message.
   */
  constructor(code: AuthError['code'], message: string) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

export default AuthService
