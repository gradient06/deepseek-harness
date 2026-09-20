/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-auth`.
 * @module @deepseek-ai/dsh-auth/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth'

/** Cordis companion plugin name. */
export const name = 'auth-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Install the session-event lifecycle contract: `auth/session-issued` and
 * `auth/session-revoked` name committed row changes, so they can only fire
 * while an auth service is live — an emission after disposal means a caller
 * leaked a session mutation past its teardown quiescence. The value relations
 * themselves (a live session maps to a real user; an expired row is reaped)
 * stay pinned by the service's own unit suite.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('auth/session-issued', ({ tokenHash }) => {
    if (ctx.get('auth') === undefined) {
      fail(`auth/session-issued for "${tokenHash}" emitted without a live auth service`)
    }
  })
  ctx.on('auth/session-revoked', ({ tokenHash }) => {
    if (ctx.get('auth') === undefined) {
      fail(`auth/session-revoked for "${tokenHash}" emitted without a live auth service`)
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
