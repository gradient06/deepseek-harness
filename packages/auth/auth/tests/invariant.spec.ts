import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import AuthService from '../src/index.ts'
import * as AuthInvariant from '../src/invariant.ts'
import type { SessionTokenHash, UserId } from '../src/types.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const HASH = 'a'.repeat(64)

describe('auth invariant companion', () => {
  it('accepts a session event emitted by a live service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-auth-'))
    dirs.push(dir)
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(AuthInvariant)
    await ctx.plugin(AuthService, {
      usersFile: join(dir, 'users.json'),
      sessionsFile: join(dir, 'sessions.sqlite'),
    })
    await ctx.auth.userAdd({ username: 'alice', password: 'pw' })

    const result = await ctx.auth.login({ username: 'alice', password: 'pw', ip: '192.0.2.1' })
    if (!('token' in result)) throw new Error('expected a token from login')
    expect(result.token).toBeTypeOf('string')
  })

  it('fails a session event emitted without a live service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(AuthInvariant)

    expect(() => { ctx.emit('auth/session-issued', { tokenHash: HASH as SessionTokenHash, userId: '1' as UserId }) })
      .toThrow(/invariant violated by "@deepseek-ai\/dsh-auth"/)
    expect(() => { ctx.emit('auth/session-revoked', { tokenHash: HASH as SessionTokenHash }) })
      .toThrow(/invariant violated by "@deepseek-ai\/dsh-auth"/)
  })

  it('reserves the package name against duplicate registration', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(AuthInvariant)

    expect(() => { ctx.invariants.register('@deepseek-ai/dsh-auth', () => {}) })
      .toThrow(/already registered/)
  })
})
