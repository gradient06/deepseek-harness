#!/usr/bin/env node
/**
 * Create or update one DSH web GUI account in the auth user store.
 *
 * The auth service (`@deepseek-ai/dsh-auth`) reads `$DSH_HOME/auth/users.json`
 * and verifies passwords against `scrypt(password, salt, 64)` stored as
 * `<saltHex>:<keyHex>`. The service exposes `userAdd`/`userChangePassword` to
 * plugins but no command-line entry, and the container has no other way to
 * bootstrap its first account: without a user, the guard answers 401 to every
 * request and the login page has nothing to accept.
 *
 * Usage:
 *   node deploy/auth-add-user.mjs <username> [--role admin] [--force]
 *
 * The password is read from the `DSH_AUTH_PASSWORD` environment variable when
 * set (non-interactive), otherwise prompted on the terminal. It is never
 * echoed back, never written to the process arguments, and only its hash is
 * stored. An existing username is refused unless `--force` is given, which
 * replaces its password (and its role, when `--role` is supplied).
 *
 * @module deploy/auth-add-user
 */

import { createInterface } from 'node:readline'
import { randomBytes, randomUUID, scrypt } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Salt length in bytes; must match the auth service's stored format. */
const SALT_BYTES = 16

/** Derived key length in bytes; must match the auth service's stored format. */
const KEY_LENGTH = 64

/**
 * Derive the stored password hash.
 * @param password - cleartext password.
 * @param salt - salt hex string, used verbatim as scrypt's salt.
 * @returns the derived key.
 */
function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (error, derived) => {
      if (error !== null) reject(error)
      else resolve(derived)
    })
  })
}

/**
 * Hash a cleartext password exactly as the auth service stores it.
 * @param password - cleartext password.
 * @returns `<saltHex>:<keyHex>`.
 */
async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES).toString('hex')
  const key = await deriveKey(password, salt)
  return `${salt}:${key.toString('hex')}`
}

/** Resolve the user store the running deployment reads. */
function usersPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'auth', 'users.json')
}

/**
 * Read the store, tolerating an absent file (an empty store) and refusing a
 * malformed one instead of silently discarding accounts.
 * @param path - absolute users.json path.
 * @returns the stored user records.
 */
function readUsers(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a JSON array`)
  return parsed
}

/**
 * Persist the store through a same-directory temp file and rename, so a crash
 * cannot leave a half-written credential file behind.
 * @param path - absolute users.json path.
 * @param users - the complete record list.
 */
function writeUsers(path, users) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(users, null, 2))
  renameSync(tmp, path)
}

/**
 * Read one line from the terminal without echoing it back to the caller.
 * @param prompt - the prompt to print.
 * @returns the entered line.
 */
async function promptPassword(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const answer = await new Promise((resolve) => {
    rl.question(prompt, resolve)
    // Suppress the echo while the password is typed.
    const original = rl._writeToOutput
    rl._writeToOutput = function (chunk) {
      if (chunk.includes(prompt)) original.call(rl, chunk)
      else original.call(rl, '*')
    }
  })
  rl.close()
  process.stdout.write('\n')
  return answer
}

const [username, ...rest] = process.argv.slice(2)
const force = rest.includes('--force')
const roleFlag = rest.indexOf('--role')
const role = roleFlag === -1 ? undefined : rest[roleFlag + 1]

if (username === undefined || username === '' || username.startsWith('--')) {
  console.error('usage: node deploy/auth-add-user.mjs <username> [--role admin] [--force]')
  process.exit(2)
}
if (roleFlag !== -1 && (role === undefined || role.startsWith('--'))) {
  console.error('error: --role needs a value')
  process.exit(2)
}

const path = usersPath()
const users = readUsers(path)
const existingIndex = users.findIndex(user => user.username === username)
if (existingIndex !== -1 && !force) {
  console.error(`error: user "${username}" already exists (pass --force to replace its password)`)
  process.exit(1)
}

const password = process.env.DSH_AUTH_PASSWORD ?? await promptPassword(`Password for ${username}: `)
if (password.length === 0) {
  console.error('error: an empty password is not accepted')
  process.exit(2)
}

const passwordHash = await hashPassword(password)
if (existingIndex === -1) {
  users.push({ id: randomUUID(), username, passwordHash, role: role ?? 'admin' })
} else {
  users[existingIndex] = {
    ...users[existingIndex],
    passwordHash,
    ...role === undefined ? {} : { role },
  }
}
writeUsers(path, users)

console.log(existingIndex === -1
  ? `created user "${username}" (role ${role ?? 'admin'}) in ${path}`
  : `updated password for "${username}" in ${path}`)
