/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with explicit index
 * entry points. A readable index renders at the dist root and configured index
 * path; missing paths return 404, traversal outside the dist root is 403,
 * unknown extensions ship as octet-stream, and non-GET/HEAD is 405. Every
 * index response runs through the webserver's index render (structured
 * injection rows, then raw taps). When the optional auth layer is composed,
 * `/` and `/index.html` redirect an unauthenticated request to the public
 * `/login` entry (a self-contained `login.html` in the dist), which is served
 * without a session so a user can authenticate; everything else stays guarded.
 * The dist location is workspace knowledge of the composing application, so
 * `distIndex` is typically supplied through a `!!js` expression, never
 * hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Service required before the fallback seat can be claimed. */
export const inject = ['webServer']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/** Structural, local view of the optional `auth` guard decision. */
type AuthDecision = { readonly ok: true } | { readonly ok: false; readonly status: number; readonly reason: string }

/** Structural, local view of the optional `auth` service guard (read via `ctx.get`). */
interface AuthGuard {
  guard(req: IncomingMessage): AuthDecision
}

/**
 * Run the optional auth layer's guard on a fallback request. An absent `auth`
 * service means the deployment runs the current unauthenticated loopback
 * behavior (zero regression); a present one must admit only authenticated
 * requests before any static asset or SPA shell is served.
 * @param ctx - the host plugin context.
 * @param req - the inbound request.
 * @returns `{ status }` when the guard denies it, or `undefined` to admit.
 */
function authDenial(ctx: Context, req: IncomingMessage): { status: number } | undefined {
  const auth = ctx.get('auth') as AuthGuard | undefined
  if (auth === undefined) return undefined
  const decision = auth.guard(req)
  return decision.ok ? undefined : { status: decision.status }
}

/** Filename of the self-contained login page served at the `/login` entry. */
const LOGIN_PAGE = 'login.html'

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param renderIndex - produces the index.html body (structured injection
 * rendering) for the dist root and configured index path.
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  renderIndex: () => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  let body: string | Buffer
  let type: string
  try {
    if (target === distRoot || target === distIndex) {
      body = await renderIndex()
      type = HTML_MIME
    } else {
      body = await readFile(target)
      type = MIME[extname(target)] ?? 'application/octet-stream'
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the webserver's request-failure handling.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': type })
  res.end(body)
}

/**
 * Claim the webserver fallback seat and serve the dist, reserving the public
 * `/login` entry (a self-contained `login.html`) so an unauthenticated user can
 * authenticate without the guard refusing its only reachable page.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  const renderIndex = async (): Promise<string> =>
    ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    // The login entry is a public page, served with or without a session: an
    // unauthenticated user needs it to authenticate, and the page's own
    // /api/auth/me redirects an already-authenticated user into the app. It is
    // a self-contained document (no guarded asset dependencies), so serving it
    // ahead of the guard does not expose the SPA shell.
    if (rawPath === '/login' || rawPath === '/login.html') {
      try {
        const body = await readFile(join(distRoot, LOGIN_PAGE))
        res.writeHead(200, { 'content-type': HTML_MIME })
        res.end(body)
        return
      } catch (error) {
        if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
        res.writeHead(404)
        res.end()
        return
      }
    }
    const denied = authDenial(ctx, req)
    if (denied !== undefined) {
      // The SPA shell (the app root) redirects to the login entry; any other
      // fallback asset is refused outright so the shell cannot be fetched
      // without a session.
      if (rawPath === '/' || rawPath === '/index.html') {
        res.writeHead(302, { location: '/login' })
        res.end()
        return
      }
      res.writeHead(denied.status)
      res.end('unauthorized')
      return
    }
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, renderIndex)
  }), 'frontend-static: fallback seat')
}
