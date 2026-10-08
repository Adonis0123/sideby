// HTTP handler for the local Panel. Mountable under any basePath; standalone and embedded use the same rules.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveRef } from '../core/accounts.ts'
import { aliasArgs, aliasRefs } from '../core/config.ts'
import { UserError } from '../core/errors.ts'
import { planHandoff } from '../core/handoff.ts'
import { buildId, packageVersion } from '../core/version.ts'
import type { AccountStatus, DoctorHistory, FamilyInfo, Runtime } from '../runtime.ts'
import type { Account, FamilyLogo, QuotaResult, QuotaSetupPlan, UsageResult } from '../types.ts'
import { renderPage } from './page.ts'
import { type PanelTheme, resolveTheme } from './theme.ts'

export const PANEL_VERSION = packageVersion()
export const MAX_BODY_BYTES = 64 * 1024
/** Write requests allowed to wait behind the running one; more get 409. */
export const MAX_QUEUED_WRITES = 4

export interface PanelHandlerOptions {
  /** A Runtime, or a factory called per request so every response reflects the disk. */
  runtime: Runtime | (() => Promise<Runtime>)
  /** Mount point such as `/accounts`; empty or `/` for the root. */
  basePath?: string
  /** Accepted `Host` header values, for example `127.0.0.1:17420`. */
  allowedHosts: string[]
  /** Rejects changes (fix, create, quota setup apply and teardown) with 403. */
  readOnly?: boolean
  version?: string
  /**
   * Design tokens that make the page match the embedding page. Checked when the handler is created: an unknown
   * token or a value that could leave its CSS declaration throws a TypeError.
   */
  theme?: PanelTheme
  /**
   * The Panel's language. `en` or `zh` wins over what the viewer saved and hides the Panel's own switch; `auto`
   * (the default) uses the viewer's saved choice, then the browser language. Checked when the handler is created:
   * any other value throws a TypeError. A Portal that changes language creates the handler again.
   */
  lang?: 'auto' | 'en' | 'zh'
}

const PANEL_LANGS = ['auto', 'en', 'zh'] as const

function resolveLang(lang: unknown): (typeof PANEL_LANGS)[number] {
  if (lang === undefined) return 'auto'
  const found = PANEL_LANGS.find((l) => l === lang)
  if (!found) throw new TypeError('panel lang must be "auto", "en" or "zh"')
  return found
}

export type PanelHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) & {
  /** Per-instance secret the page sends as `x-sideby-token`. */
  readonly token: string
}

export type PanelAccount = (AccountStatus | (Account & Partial<AccountStatus>)) & {
  quota?: QuotaResult
  usage?: UsageResult
  error?: string
  /** Latest Doctor result for this Account; absent when it was never checked. */
  health?: { at: string; fail: number; warn: number }
  /** Config `aliases` that point at this Account, sorted; absent when none do. */
  aliases?: string[]
  /** Host arguments of those aliases that add any (alias → arguments); absent when none do. */
  aliasArgs?: Record<string, string[]>
}

export type { DoctorHistory }

/** Counts of failing and warning Findings per checked Account, from the Doctor history. */
export function healthByAccount(
  history: DoctorHistory | undefined,
): Map<string, { at: string; fail: number; warn: number }> {
  const out = new Map<string, { at: string; fail: number; warn: number }>()
  for (const [ref, entry] of Object.entries(history?.accounts ?? {}))
    out.set(ref, {
      at: entry.at,
      fail: entry.findings.filter((f) => f.level === 'fail').length,
      warn: entry.findings.filter((f) => f.level === 'warn').length,
    })
  return out
}

/** Alias names per Account ref, sorted. An alias whose target matches no Account is left out. */
export function aliasesByAccount(
  aliases: Readonly<Record<string, string>> | undefined,
  accounts: readonly Account[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    let ref: string
    try {
      ref = resolveRef(target, accounts).ref
    } catch {
      continue
    }
    out.set(ref, [...(out.get(ref) ?? []), alias].sort())
  }
  return out
}

/** A Family as the page sees it: FamilyInfo plus the mark from its FamilyDef. */
export type PanelFamily = FamilyInfo & { logo?: FamilyLogo }

export interface PanelState {
  schemaVersion: 1
  version: string
  /** buildId() of the process serving the Panel: a page from another build reloads itself. */
  build: string
  readOnly: boolean
  generatedAt: string
  families: PanelFamily[]
  accounts: PanelAccount[]
  pluginErrors: { where: string; message: string }[]
  quotaSetups: { family: string; summary: string; plan: QuotaSetupPlan }[]
  /** Latest Doctor result per Account and per Family. */
  history?: DoctorHistory
  /** The config `aliases` as alias → Account ref (arguments left out), so the page can tell which names are taken. */
  configAliases?: Record<string, string>
  /**
   * Family → the Account `sideby next <family>` would pick (spec §3.13). Only Families with a Quota source,
   * at least two subscription Accounts, some Quota data and a pick; API Accounts are left out as in the CLI default.
   */
  handoff?: Record<string, string>
}

/** The `handoff` map of the Panel state, from the statuses and Quota already read for the page. */
export function handoffByFamily(
  rt: Runtime,
  accounts: readonly PanelAccount[],
  now: Date,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, f] of rt.families) {
    const list = accounts.filter((a) => a.family === id)
    if (!f.readQuota || list.filter((a) => a.kind === 'subscription').length < 2) continue
    const plan = planHandoff(
      id,
      list.map((a) => ({
        ref: a.ref,
        name: a.name,
        isMain: a.isMain,
        kind: a.kind,
        login: a.login ?? 'unknown',
        quota: a.quota ?? { status: 'unavailable', reason: 'unrecognized' },
      })),
      now,
    )
    if (plan.pick && plan.hasQuota) out[id] = plan.pick
  }
  return out
}

class HttpError extends Error {
  readonly status: number
  /** Machine-readable reason the page acts on, such as `bad-token`. */
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    if (code) this.code = code
  }
}

function normalizeBase(p: string | undefined): string {
  if (!p || p === '/') return ''
  const withSlash = p.startsWith('/') ? p : `/${p}`
  return withSlash.replace(/\/+$/, '')
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    return Promise.reject(new HttpError(413, `request body over ${MAX_BODY_BYTES} bytes`))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (c: Buffer) => {
      if (failed) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        failed = true
        reject(new HttpError(413, `request body over ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(c)
    })
    req.on('error', (err) => {
      if (!failed) reject(err)
    })
    req.on('end', () => {
      if (failed) return
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
          return reject(new HttpError(400, 'request body must be a JSON object'))
        resolve(parsed)
      } catch {
        reject(new HttpError(400, 'request body is not valid JSON'))
      }
    })
  })
}

function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be a string`)
  return v
}

function optBool(body: Record<string, unknown>, key: string): boolean {
  const v = body[key]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw new HttpError(400, `"${key}" must be true or false`)
  return v
}

async function accountState(rt: Runtime, account: Account, families: FamilyInfo[]): Promise<PanelAccount> {
  const errors: string[] = []
  const guard = async <T>(p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p
    } catch (err) {
      errors.push((err as Error).message)
      return undefined
    }
  }
  const [status, quota, usage] = await Promise.all([
    guard(rt.status(account)),
    guard(rt.quota(account)),
    guard(rt.usage(account)),
  ])
  const fam = families.find((f) => f.id === account.family)
  const base: PanelAccount = status ?? {
    ...account,
    familyTitle: fam?.title ?? account.family,
    hostInstalled: fam?.installed ?? false,
    login: 'unknown',
  }
  errors.push(...(status?.problems ?? []))
  return {
    ...base,
    ...(quota ? { quota } : {}),
    ...(usage ? { usage } : {}),
    ...(errors.length ? { error: errors.join('; ') } : {}),
  }
}

async function buildState(
  rt: Runtime,
  opts: { version: string; build: string; readOnly: boolean },
): Promise<PanelState> {
  const ctx = rt.readContext()
  const [families, accounts, history, quotaSetups] = await Promise.all([
    rt.familyInfo(),
    rt.accounts(),
    rt.doctorHistory(),
    rt.quotaSetups(),
  ])
  const health = healthByAccount(history)
  const aliases = aliasesByAccount(aliasRefs(rt.config.aliases), accounts)
  const list = await Promise.all(
    accounts.map(async (a): Promise<PanelAccount> => {
      const st = await accountState(rt, a, families)
      const h = health.get(a.ref)
      const names = aliases.get(a.ref)
      const withArgs = (names ?? [])
        .map((n) => [n, aliasArgs(rt.config.aliases?.[n])] as const)
        .filter(([, args]) => args.length)
      return {
        ...st,
        ...(h ? { health: h } : {}),
        ...(names ? { aliases: names } : {}),
        ...(withArgs.length ? { aliasArgs: Object.fromEntries(withArgs) } : {}),
      }
    }),
  )
  const handoff = handoffByFamily(rt, list, ctx.now)
  return {
    schemaVersion: 1,
    version: opts.version,
    build: opts.build,
    readOnly: opts.readOnly,
    generatedAt: ctx.now.toISOString(),
    families: families.map((f) => {
      const logo = rt.families.get(f.id)?.logo
      return logo ? { ...f, logo } : f
    }),
    accounts: list,
    pluginErrors: rt.pluginErrors.map((e) => ({ where: e.where, message: e.message })),
    quotaSetups,
    ...(history ? { history } : {}),
    ...(rt.config.aliases ? { configAliases: aliasRefs(rt.config.aliases) } : {}),
    ...(Object.keys(handoff).length ? { handoff } : {}),
  }
}

/** Runs write requests one at a time; a few may wait, the rest are told to retry. */
function writeQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  let inFlight = 0
  return <T>(fn: () => Promise<T>): Promise<T> => {
    if (inFlight > MAX_QUEUED_WRITES)
      return Promise.reject(new HttpError(409, 'another change is still running; try again in a moment'))
    inFlight++
    const run = tail.then(fn)
    tail = run.catch(() => undefined)
    return run.finally(() => {
      inFlight--
    })
  }
}

export function createPanelHandler(opts: PanelHandlerOptions): PanelHandler {
  const basePath = normalizeBase(opts.basePath)
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()))
  const readOnly = Boolean(opts.readOnly)
  const version = opts.version ?? PANEL_VERSION
  const build = buildId()
  const theme = resolveTheme(opts.theme)
  const lang = resolveLang(opts.lang)
  const token = randomBytes(32).toString('base64url')
  const serial = writeQueue()
  const getRuntime = typeof opts.runtime === 'function' ? opts.runtime : async () => opts.runtime as Runtime

  // Every route declares whether a request writes files. `writes` defaults to true, so a route that forgets
  // to declare it is refused by a read-only Panel instead of slipping through.
  interface Route {
    writes?: (body: Record<string, unknown>) => boolean
    run(body: Record<string, unknown>): Promise<unknown>
  }
  const routes: Record<string, Route> = {
    '/api/doctor': {
      // Only the record of the check is written, and a read-only Panel skips that (persist: false).
      writes: () => false,
      async run(body) {
        const target = optString(body, 'target')
        const rt = await getRuntime()
        return rt.doctorWithHistory({ persist: !readOnly, ...(target ? { target } : {}) })
      },
    },
    '/api/fix': {
      async run(body) {
        const target = optString(body, 'target')
        const force = optBool(body, 'force')
        const rt = await getRuntime()
        return rt.doctorWithHistory({ fix: true, force, ...(target ? { target } : {}) })
      },
    },
    '/api/accounts': {
      async run(body) {
        const family = optString(body, 'family')
        const name = optString(body, 'name')
        if (!family || !name) throw new HttpError(400, 'pick a family and enter a name')
        const api = optBool(body, 'api')
        const alias = optString(body, 'alias')
        const rt = await getRuntime()
        return rt.createAccount(family, name, { api, ...(alias ? { alias } : {}) })
      },
    },
    '/api/quota/setup': {
      writes: (body) => body.confirm === true,
      async run(body) {
        const family = optString(body, 'family')
        const confirm = optBool(body, 'confirm')
        if (!family) throw new HttpError(400, '"family" is required')
        const rt = await getRuntime()
        const setup = rt.quotaSetup(family)
        const plan = confirm ? await setup.apply() : await setup.plan()
        return { family, summary: setup.summary, plan }
      },
    },
    // Undo for the setup above; the Runtime turns a teardown that throws into `{ ok: false, message }`.
    '/api/quota/teardown': {
      async run(body) {
        const family = optString(body, 'family')
        if (!family) throw new HttpError(400, '"family" is required')
        const rt = await getRuntime()
        return { family, result: await rt.quotaSetup(family).teardown() }
      },
    },
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname
    } catch {
      return false
    }
    if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) return false
    const sub = pathname.slice(basePath.length) || '/'

    try {
      const host = (req.headers.host ?? '').toLowerCase()
      if (!allowed.has(host)) throw new HttpError(403, 'host not allowed')
      const method = req.method ?? 'GET'

      if (method === 'GET' || method === 'HEAD') {
        if (sub === '/' || sub === '/index.html') {
          const nonce = randomBytes(16).toString('base64')
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'referrer-policy': 'no-referrer',
            'content-security-policy': [
              "default-src 'none'",
              `script-src 'nonce-${nonce}'`,
              `style-src 'nonce-${nonce}'`,
              "connect-src 'self'",
              "img-src 'self' data:",
              "base-uri 'none'",
              "form-action 'none'",
              "frame-ancestors 'self'",
            ].join('; '),
          })
          res.end(
            method === 'HEAD'
              ? undefined
              : renderPage({ basePath, token, nonce, version, build, readOnly, theme, lang }),
          )
          return true
        }
        if (sub === '/api/health') {
          send(res, 200, { app: 'sideby', version, build })
          return true
        }
        // The page fetches a fresh token here after the server restarted (a new process, a new token).
        // It reveals nothing a same-origin read of the page does not; a cross-site page cannot read it.
        if (sub === '/api/session') {
          if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'origin not allowed')
          send(res, 200, { token })
          return true
        }
        if (sub === '/api/state') {
          send(res, 200, await buildState(await getRuntime(), { version, build, readOnly }))
          return true
        }
        if (Object.hasOwn(routes, sub)) throw new HttpError(405, 'use POST')
        throw new HttpError(404, 'not found')
      }

      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      const route = Object.hasOwn(routes, sub) ? routes[sub] : undefined
      if (!route) throw new HttpError(404, 'not found')
      const origin = req.headers.origin
      if (!origin || origin.toLowerCase() !== `http://${host}`) throw new HttpError(403, 'origin not allowed')
      const given = req.headers['x-sideby-token']
      if (typeof given !== 'string' || !sameSecret(given, token))
        throw new HttpError(403, 'missing or wrong x-sideby-token; reload the page', 'bad-token')
      const body = (await readBody(req)) as Record<string, unknown>
      if (readOnly && (route.writes?.(body) ?? true)) throw new HttpError(403, 'this panel is read-only')
      // Reads that record history (doctor) also run in this queue, so overlapping checks merge in order.
      send(res, 200, await serial(() => route.run(body)))
      return true
    } catch (err) {
      if (res.headersSent) {
        res.end()
        return true
      }
      if (err instanceof HttpError) {
        const body = err.code ? { error: err.message, code: err.code } : { error: err.message }
        send(res, err.status, body, err.status === 413 ? { connection: 'close' } : {})
        if (err.status === 413) req.resume()
      } else if (err instanceof UserError) {
        send(res, 400, err.code ? { error: err.message, code: err.code } : { error: err.message })
      } else {
        send(res, 500, { error: (err as Error)?.message || 'internal error' })
      }
      return true
    }
  }
  return Object.assign(handle, { token })
}
