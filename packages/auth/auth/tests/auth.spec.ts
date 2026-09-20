import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import AuthService, { type AuthError, type LoginResult, type User } from '../src/index.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Mount a service on a throwaway temp home under the configured maxAttempts. */
async function mount(config: Record<string, unknown> = {}): Promise<{ ctx: Context; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auth-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(AuthService, {
    usersFile: join(dir, 'users.json'),
    sessionsFile: join(dir, 'sessions.sqlite'),
    ...config,
  })
  return { ctx, dir }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function cookieHeader(name: string, value: string): Record<string, string> {
  return { cookie: `${name}=${value}` }
}

const ip = '192.0.2.1'

/** Assert a login result is a token and return it (narrows the union). */
function expectLoginToken(result: LoginResult | AuthError): string {
  if (!('token' in result)) throw new Error('expected a token from login')
  expect(result.token).toBeTypeOf('string')
  return result.token
}

describe('password hashing (scrypt)', () => {
  it('stores salt:hash and verifies the correct password', async () => {
    const { ctx, dir } = await mount()
    const added = await ctx.auth.userAdd({ username: 'alice', password: 'correct horse' })

    expect(added).not.toHaveProperty('passwordHash')
    const store = JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8')) as Array<{ passwordHash: string }>
    const stored = store[0]?.passwordHash
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)

    const result = await ctx.auth.login({ username: 'alice', password: 'correct horse', ip })
    expectLoginToken(result)
  })

  it('rejects a wrong password and reports the generic message', async () => {
    const { ctx } = await mount()
    await ctx.auth.userAdd({ username: 'alice', password: 'right' })

    const result = await ctx.auth.login({ username: 'alice', password: 'wrong', ip })
    expect(result).toEqual({ code: 'invalid-credentials', message: 'invalid username or password' })
  })

  it('does not reveal whether a username exists (unknown user equal path)', async () => {
    const { ctx } = await mount()

    const missing = await ctx.auth.login({ username: 'nobody', password: 'whatever', ip })
    expect(missing).toMatchObject({ code: 'invalid-credentials' })
    expect(missing).toMatchObject({ message: 'invalid username or password' })
  })
})

describe('login and sessions', () => {
  it('mints a unique token and verifies it back to its user', async () => {
    const { ctx } = await mount()
    await ctx.auth.userAdd({ username: 'alice', password: 'pw', role: 'admin' })

    const first = await ctx.auth.login({ username: 'alice', password: 'pw', ip })
    const second = await ctx.auth.login({ username: 'alice', password: 'pw', ip })
    expectLoginToken(first)
    expectLoginToken(second)
    if (!('token' in first) || !('token' in second)) throw new Error('expected tokens')
    expect(first.token).not.toBe(second.token)

    const user = ctx.auth.verify(first.token)
    expect(user).toMatchObject({ username: 'alice', role: 'admin' })
    expect(user).not.toHaveProperty('passwordHash')
  })

  it('returns null for an unknown or malformed token', () => {
    const service = getService()
    expect(service.verify('')).toBeNull()
    expect(service.verify('a'.repeat(64))).toBeNull()
  })

  it('revokes a session on logout, and revoking absent is a no-op', async () => {
    const { ctx } = await mount()
    await ctx.auth.userAdd({ username: 'alice', password: 'pw' })
    const result = await ctx.auth.login({ username: 'alice', password: 'pw', ip })
    if (!('token' in result)) throw new Error('expected token')
    const token = result.token

    expect(ctx.auth.verify(token)).not.toBeNull()
    ctx.auth.logout(token)
    expect(ctx.auth.verify(token)).toBeNull()
    ctx.auth.logout(token)
  })

  it('reaps an expired session on read and emits session-revoked', async () => {
    const { ctx, dir } = await mount()
    await ctx.auth.userAdd({ username: 'alice', password: 'pw' })
    const result = await ctx.auth.login({ username: 'alice', password: 'pw', ip })
    if (!('token' in result)) throw new Error('expected token')
    const token = result.token

    const revoked: unknown[] = []
    ctx.on('auth/session-revoked', (record) => { revoked.push(record) })

    // Backdate the row through a second connection to the same file.
    const db = new DatabaseSync(join(dir, 'sessions.sqlite'))
    db.prepare('UPDATE sessions SET expiresAt = 0').run()
    db.close()

    expect(ctx.auth.verify(token)).toBeNull()
    expect(revoked).toHaveLength(1)

    // The reaped row is gone.
    const left = new DatabaseSync(join(dir, 'sessions.sqlite'))
    const count = left.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(count.n).toBe(0)
    left.close()
  })

  it('touches lastSeenAt on a live verify', async () => {
    const { ctx, dir } = await mount()
    await ctx.auth.userAdd({ username: 'alice', password: 'pw' })
    const result = await ctx.auth.login({ username: 'alice', password: 'pw', ip })
    if (!('token' in result)) throw new Error('expected token')
    const token = result.token

    ctx.auth.verify(token)
    const db = new DatabaseSync(join(dir, 'sessions.sqlite'))
    const row = db.prepare('SELECT lastSeenAt FROM sessions LIMIT 1').get() as { lastSeenAt: number }
    expect(row.lastSeenAt).toBeGreaterThan(0)
    db.close()
  })
})

describe('rate limit lockout', () => {
  it('locks the username+ip key after maxAttempts, then clears after lockoutMs', async () => {
    const { ctx } = await mount({ maxAttempts: 2, lockoutMs: 40 })
    await ctx.auth.userAdd({ username: 'alice', password: 'right' })

    const failed1 = await ctx.auth.login({ username: 'alice', password: 'wrong', ip })
    const failed2 = await ctx.auth.login({ username: 'alice', password: 'wrong', ip })
    expect(failed1).toMatchObject({ code: 'invalid-credentials' })
    expect(failed2).toMatchObject({ code: 'invalid-credentials' })

    const locked = await ctx.auth.login({ username: 'alice', password: 'right', ip })
    expect(locked).toMatchObject({ code: 'rate-limited' })

    await new Promise(resolve => setTimeout(resolve, 60))
    const recovered = await ctx.auth.login({ username: 'alice', password: 'right', ip })
    expectLoginToken(recovered)
  })

  it('keys attempts per username so another username is unaffected', async () => {
    const { ctx } = await mount({ maxAttempts: 2 })
    await ctx.auth.userAdd({ username: 'alice', password: 'pw' })
    await ctx.auth.userAdd({ username: 'bob', password: 'pw' })

    await ctx.auth.login({ username: 'alice', password: 'wrong', ip })
    await ctx.auth.login({ username: 'alice', password: 'wrong', ip })

    const bobResult = await ctx.auth.login({ username: 'bob', password: 'pw', ip })
    expectLoginToken(bobResult)
  })
})

describe('guard and me', () => {
  it('admits with auth enabled on a valid bearer and denies otherwise', async () => {
    const { ctx } = await mount()
    await ctx.auth.userAdd({ username: 'alice', password: 'pw' })
    const result = await ctx.auth.login({ username: 'alice', password: 'pw', ip })
    if (!('token' in result)) throw new Error('expected token')

    expect(ctx.auth.guard({ headers: bearer(result.token) })).toEqual({ ok: true })
    expect(ctx.auth.guard({ headers: {} })).toMatchObject({ ok: false, status: 401 })
    expect(ctx.auth.guard({ headers: bearer('deadbeef') })).toMatchObject({ ok: false, status: 401 })
  })

  it('reads the configured session cookie and resolves me', async () => {
    const { ctx } = await mount({ cookieName: 'dsh_session' })
    await ctx.auth.userAdd({ username: 'alice', password: 'pw' })
    const result = await ctx.auth.login({ username: 'alice', password: 'pw', ip })
    if (!('token' in result)) throw new Error('expected token')

    expect(ctx.auth.guard({ headers: cookieHeader('dsh_session', result.token) })).toEqual({ ok: true })
    expect(ctx.auth.me(cookieHeader('dsh_session', result.token))).toMatchObject({ username: 'alice' })
    expect(ctx.auth.me({})).toBeNull()
    expect(ctx.auth.me(cookieHeader('other', result.token))).toBeNull()
  })

  it('allows every request when auth is disabled (reachability fence only)', async () => {
    const { ctx } = await mount({ enabled: false })
    expect(ctx.auth.guard({ headers: {} })).toEqual({ ok: true })
    expect(ctx.auth.guard({ headers: bearer('anything') })).toEqual({ ok: true })
  })
})

describe('user management', () => {
  it('adds, lists, removes, and changes password', async () => {
    const { ctx } = await mount()
    await ctx.auth.userAdd({ username: 'alice', password: 'first' })
    const bob = await ctx.auth.userAdd({ username: 'bob', password: 'second', role: 'admin' })

    expect(bob).toMatchObject({ username: 'bob', role: 'admin' })
    expect(ctx.auth.userList()).toHaveLength(2)
    expect(ctx.auth.userList()[0]).not.toHaveProperty('passwordHash')

    // Duplicate username rejected.
    await expect(ctx.auth.userAdd({ username: 'alice', password: 'x' }))
      .rejects.toThrow(/already exists/)

    await ctx.auth.userChangePassword('alice', 'changed')
    const wrong = await ctx.auth.login({ username: 'alice', password: 'first', ip })
    expect(wrong).toMatchObject({ code: 'invalid-credentials' })
    const right = await ctx.auth.login({ username: 'alice', password: 'changed', ip })
    expectLoginToken(right)

    await expect(ctx.auth.userChangePassword('nobody', 'x')).rejects.toThrow(/does not exist/)

    expect(ctx.auth.userRemove('bob')).toBe(true)
    expect(ctx.auth.userRemove('bob')).toBe(false)
    expect(ctx.auth.userList().map(user => user.username)).toEqual(['alice'])
  })

  it('applies the configured default role to role-less users', async () => {
    const { ctx } = await mount({ role: 'operator' })
    const user = await ctx.auth.userAdd({ username: 'alice', password: 'pw' })
    expect(user.role).toBe('operator')
  })
})

describe('requireRole', () => {
  it('admits users whose role is among the gate roles', async () => {
    const { ctx } = await mount()
    const admin: User = { id: '1' as User['id'], username: 'a', role: 'admin' }
    const user: User = { id: '2' as User['id'], username: 'u', role: 'user' }
    const isAdmin = ctx.auth.requireRole('admin')
    const isOperator = ctx.auth.requireRole('operator', 'admin')

    expect(isAdmin(admin)).toBe(true)
    expect(isAdmin(user)).toBe(false)
    expect(isOperator(user)).toBe(false)
    expect(isOperator(admin)).toBe(true)
  })
})

describe('no secret leakage', () => {
  it('keeps password hashes and raw tokens out of every public surface', async () => {
    const { ctx } = await mount()
    await ctx.auth.userAdd({ username: 'alice', password: 'super-secret-password' })

    const issued: unknown[] = []
    ctx.on('auth/session-issued', (record) => { issued.push(record) })

    const result = await ctx.auth.login({ username: 'alice', password: 'super-secret-password', ip })
    if (!('token' in result)) throw new Error('expected token')
    const token = result.token

    const user = ctx.auth.verify(token)
    expect(user).not.toHaveProperty('passwordHash')
    expect(JSON.stringify(user)).not.toContain('super-secret-password')
    expect(JSON.stringify(ctx.auth.me(bearer(token)))).not.toContain('super-secret-password')
    expect(JSON.stringify(ctx.auth.userList())).not.toContain('super-secret-password')

    // The issued event carries only a token hash, never the raw token.
    expect(JSON.stringify(issued)).not.toContain(token)
    const hash = JSON.stringify(issued[0])
    expect(hash).toMatch(/[0-9a-f]{64}/)

    // A denial reason never echoes credentials.
    const denial = ctx.auth.guard({ headers: bearer('deadbeef') })
    if (denial.ok) throw new Error('expected denial')
    expect(denial.reason.toLowerCase()).not.toContain('deadbeef')
  })
})

/** Fake webServer that records exact-path registrations. */
function fakeWebServer(routes: WebRoute[]): Pick<WebServer, 'register'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
  }
}

/** Build a fake IncomingMessage, recorder, and response state for one route call. */
function fakeHttpPair(init: {
  method: string
  headers: Record<string, string>
  url?: string
  body?: unknown
}): { req: IncomingMessage; res: ServerResponse; state: { status?: number; body?: string; headers: Record<string, unknown> } } {
  const source = init.body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(init.body))])
  const req = source as unknown as IncomingMessage
  Object.assign(req, {
    method: init.method,
    headers: init.headers,
    url: init.url ?? '/api/auth/login',
    socket: { remoteAddress: '192.0.2.1' },
  })
  const state: { status?: number; body?: string; headers: Record<string, unknown> } = { headers: {} }
  const chunks: Buffer[] = []
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    setHeader(name: string, value: unknown) { state.headers[name] = value; return this },
    writeHead(value: number, extra?: Record<string, unknown>) {
      state.status = value
      if (extra !== undefined) Object.assign(state.headers, extra)
      return this
    },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(value?: string | Uint8Array) {
      if (value !== undefined) chunks.push(Buffer.from(value))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { req, res, state }
}

describe('self-registered HTTP routes', () => {
  async function mountRouted(): Promise<{ ctx: Context; routes: WebRoute[]; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-auth-'))
    dirs.push(dir)
    const routes: WebRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', fakeWebServer(routes) as WebServer)
    await ctx.plugin(AuthService, {
      usersFile: join(dir, 'users.json'),
      sessionsFile: join(dir, 'sessions.sqlite'),
    })
    // The soft webServer inject fires on a turn boundary; let it register.
    await new Promise<void>(resolve => setImmediate(resolve))
    return { ctx, routes, dir }
  }

  it('registers exact login/logout/me routes and drives the login → me → logout lifecycle', async () => {
    const { ctx, routes } = await mountRouted()
    await ctx.auth.userAdd({ username: 'alice', password: 'pw', role: 'admin' })
    expect(routes.map(route => route.path).sort()).toEqual(['/api/auth/login', '/api/auth/logout', '/api/auth/me'])
    expect(routes.every(route => route.kind === 'exact')).toBe(true)

    const login = routes.find(route => route.path === '/api/auth/login')!
    const me = routes.find(route => route.path === '/api/auth/me')!
    const logout = routes.find(route => route.path === '/api/auth/logout')!

    // Successful login sets the HttpOnly session cookie and returns the user.
    const ok = fakeHttpPair({ method: 'POST', headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' }, body: { username: 'alice', password: 'pw' } })
    await login.handler(ok.req, ok.res)
    expect(ok.state.status).toBe(200)
    expect(JSON.parse(String(ok.state.body))).toMatchObject({ ok: true, user: { username: 'alice', role: 'admin' } })
    const setCookie = ok.state.headers['Set-Cookie'] as string
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    const token = setCookie.split(';')[0]!.slice('dsh_session='.length)

    // The cookie resolves /me back to the user.
    const looked = fakeHttpPair({ method: 'GET', headers: { host: '127.0.0.1:3080', cookie: `dsh_session=${token}` }, url: '/api/auth/me' })
    await me.handler(looked.req, looked.res)
    expect(looked.state.status).toBe(200)
    expect(JSON.parse(String(looked.state.body))).toMatchObject({ user: { username: 'alice' } })

    // Wrong password is a generic 401 with a retry-after hint.
    const bad = fakeHttpPair({ method: 'POST', headers: { host: '127.0.0.1:3080' }, body: { username: 'alice', password: 'wrong' } })
    await login.handler(bad.req, bad.res)
    expect(bad.state.status).toBe(401)
    expect(bad.state.headers['retry-after']).toBe('60')

    // Logout revokes the session; /me is then 401.
    const out = fakeHttpPair({ method: 'POST', headers: { host: '127.0.0.1:3080', cookie: `dsh_session=${token}` }, url: '/api/auth/logout' })
    await logout.handler(out.req, out.res)
    expect(out.state.status).toBe(200)
    const after = fakeHttpPair({ method: 'GET', headers: { host: '127.0.0.1:3080', cookie: `dsh_session=${token}` }, url: '/api/auth/me' })
    await me.handler(after.req, after.res)
    expect(after.state.status).toBe(401)

    // An untrusted host is refused by the auth route's own fence (403).
    const untrusted = fakeHttpPair({ method: 'POST', headers: { host: 'harness.example' }, body: { username: 'alice', password: 'pw' } })
    await login.handler(untrusted.req, untrusted.res)
    expect(untrusted.state.status).toBe(403)
  })

  it('stays usable without a composed webServer (no routes, bare seam)', async () => {
    const { ctx } = await mount()
    expect(ctx.auth.guard({ headers: {} })).toMatchObject({ ok: false, status: 401 })
  })
})

/** Construct a bare service (direct, no plugin) for pure token-parse assertions. */
function getService(): AuthService {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auth-'))
  dirs.push(dir)
  return new AuthService(new Context(), {
    usersFile: join(dir, 'users.json'),
    sessionsFile: join(dir, 'sessions.sqlite'),
  })
}
