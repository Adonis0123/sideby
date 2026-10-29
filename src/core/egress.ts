// The Egress check behind Network Guard (spec §3.35, ADR-0053). A leaf module: `network-hook` runs it on every prompt
// and tool call, so it imports only Node built-ins and core/fs-safe.ts. It asks the vendor's own
// `/cdn-cgi/trace` through the Host's proxy settings, keeps the country and a hash of the address, and decides.
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { connect as tlsConnect } from 'node:tls'
import { writeFileAtomic } from './fs-safe.ts'

/** Variables a launched Host reads for its proxy; the check uses the same ones, so it takes the same route. */
export const PROXY_VARS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const

/** What `network-hook` reads from the session's environment; set by sideby at Launch. */
export const NETWORK_ENV = {
  url: 'SIDEBY_NETWORK_URL',
  allow: 'SIDEBY_NETWORK_ALLOW',
  dir: 'SIDEBY_NETWORK_DIR',
} as const

export const TIMEOUT_MS = 3000
/**
 * Inside a session a check that cannot tell is asked again after these waits, before it blocks: a prompt the Host made
 * itself (a background task's notification) is not sent again once blocked, and a short outage would drop it.
 */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const
/**
 * All tries of one in-session check end within this time: five requests of at most 3 seconds and the waits between
 * them. It stays under the 60-second timeout sideby gives its Claude hooks (core/network.ts) and Codex's 600-second
 * default.
 */
export const RETRY_BUDGET_MS = 30_000
/** A result this young is used as it is. */
export const FRESH_MS = 60_000
/** Up to this age a tool call goes on while a detached process refreshes the result. */
export const STALE_MS = 5 * 60_000

export type EgressStatus = 'ok' | 'blocked' | 'unknown'
/** When a check happens: before a Launch, before a prompt, or before a tool call (spec §3.35 table). */
export type CheckMoment = 'launch' | 'prompt' | 'tool'

export interface EgressEntry {
  url: string
  /** ISO time of the request. */
  checkedAt: string
  /** Country code from `loc=`, absent when the check could not tell. */
  loc?: string
  /** SHA-256 of the address; the address itself is never kept. */
  ipHash?: string
  /** When a check last saw another address than the one before. */
  ipChangedAt?: string
  /** Why the check could not tell, in plain words. */
  error?: string
  /** Hash of the machine's network addresses at the time of the check. */
  netPrint: string
}

export interface Verdict {
  status: EgressStatus
  entry: EgressEntry
  /** True when this call asked the network (not the cache). */
  fresh: boolean
  /** True when this call saw the address change. */
  ipChanged: boolean
  /** Requests this call made (more than one when it asked again after a check that could not tell). */
  attempts?: number
  /** Time from the first request to the answer, in milliseconds. */
  triedMs?: number
}

type Env = Record<string, string | undefined>

export type TraceFetcher = (url: string, env: Env, timeoutMs: number) => Promise<string>
export type Sleep = (ms: number) => Promise<unknown>

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** The proxy a request to `url` goes through under `env`, or null for a direct connection. */
export function proxyFor(url: string, env: Env): string | null {
  const host = new URL(url).hostname.toLowerCase()
  const no = env.NO_PROXY ?? env.no_proxy ?? ''
  for (const raw of no.split(',')) {
    const p = raw.trim().toLowerCase().replace(/:\d+$/, '')
    if (!p) continue
    if (p === '*') return null
    const bare = p.replace(/^\*?\./, '')
    if (host === bare || host.endsWith(`.${bare}`)) return null
  }
  const v = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy
  return v ? v.trim() : null
}

/** The key a cached result is kept under: the URL and the proxy settings, never their values in clear. */
export function cacheKey(url: string, env: Env): string {
  return sha(JSON.stringify([url, ...PROXY_VARS.map((k) => env[k] ?? '')])).slice(0, 32)
}

/** A hash of the machine's own network addresses; it changes with Wi-Fi, a VPN or a TUN device. */
export function netPrint(read: typeof networkInterfaces = networkInterfaces): string {
  const all: string[] = []
  try {
    for (const [name, list] of Object.entries(read())) {
      for (const a of list ?? []) if (!a.internal) all.push(`${name}/${a.address}`)
    }
  } catch {
    // no interfaces readable: one constant print
  }
  return sha(all.sort().join('\n')).slice(0, 32)
}

export function parseTrace(text: string): { ip?: string; loc?: string } {
  const out: { ip?: string; loc?: string } = {}
  for (const line of text.split('\n')) {
    const [k, v] = line.split('=', 2)
    if (k === 'ip' && v) out.ip = v.trim()
    if (k === 'loc' && v && /^[A-Z]{2}$/.test(v.trim())) out.loc = v.trim()
  }
  return out
}

/**
 * One GET of an `https://` `url`, directly or through an `http://` proxy (CONNECT), as the Host would send it. The
 * Update Check uses it too, since Node's own `fetch` does not follow the proxy variables.
 */
export const fetchTrace = (
  url: string,
  env: Env,
  timeoutMs: number,
  userAgent = 'sideby-network-guard',
): Promise<string> =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const proxy = proxyFor(url, env)
    let done = false
    // Requests and sockets this call opened. A failure (a timeout included) destroys them, so no handle outlives the
    // call: a proxy that accepts and never answers would otherwise keep `network-hook` alive past the Host's timeout.
    const open: { destroy(): unknown }[] = []
    const finish = (err: Error | null, body?: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) {
        for (const h of open) h.destroy()
        reject(err)
      } else resolve(body ?? '')
    }
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs)
    const read = (res: import('node:http').IncomingMessage) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume()
        return finish(new Error(`HTTP ${res.statusCode}`))
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        if (body.length < 4096) body += c
      })
      res.on('end', () => finish(null, body))
      res.on('error', (e) => finish(e))
    }
    const get = (socket?: import('node:tls').TLSSocket) => {
      const req = httpsRequest(
        {
          host: target.hostname,
          path: target.pathname + target.search,
          method: 'GET',
          headers: { 'user-agent': userAgent, accept: 'application/json, text/plain' },
          ...(socket ? { createConnection: () => socket } : {}),
        },
        read,
      )
      open.push(req)
      req.on('error', (e) => finish(e))
      req.end()
    }
    if (!proxy) return get()
    let p: URL
    try {
      p = new URL(proxy.includes('://') ? proxy : `http://${proxy}`)
    } catch {
      return finish(new Error('the proxy address is not a URL'))
    }
    if (p.protocol !== 'http:')
      return finish(new Error(`a ${p.protocol.replace(':', '')} proxy is not supported`))
    const headers: Record<string, string> = { host: `${target.hostname}:443` }
    if (p.username)
      headers['proxy-authorization'] =
        `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}`
    const req = httpRequest({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers,
    })
    open.push(req)
    req.on('connect', (res, socket) => {
      open.push(socket)
      if (res.statusCode !== 200) {
        socket.destroy()
        return finish(new Error(`the proxy answered ${res.statusCode}`))
      }
      if (done) return
      const tls = tlsConnect({ socket, servername: target.hostname })
      open.push(tls)
      tls.on('error', (e) => finish(e))
      get(tls)
    })
    req.on('error', (e) => finish(e))
    req.end()
  })

/** Plain words for a failed request; never the proxy address or its password. */
function failure(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  if (e?.message === 'timeout') return 'no answer within 3 seconds'
  if (e?.code === 'ECONNREFUSED') return 'the connection was refused (is the proxy running?)'
  if (e?.code === 'ENOTFOUND' || e?.code === 'EAI_AGAIN')
    return 'the address could not be looked up (offline?)'
  if (e?.message?.startsWith('HTTP ') || e?.message?.startsWith('the proxy') || e?.message?.startsWith('a '))
    return e.message
  return 'the request failed'
}

const entryFile = (dir: string, key: string) => join(dir, `${key}.json`)

export async function readEntry(dir: string, key: string): Promise<EgressEntry | null> {
  try {
    const v = JSON.parse(await readFile(entryFile(dir, key), 'utf8')) as EgressEntry
    return typeof v?.checkedAt === 'string' && typeof v.netPrint === 'string' ? v : null
  } catch {
    return null
  }
}

/** Whether `loc` passes `allow`; without a country the check could not tell. */
export function judge(entry: EgressEntry, allow: readonly string[]): EgressStatus {
  if (!entry.loc) return 'unknown'
  return allow.includes(entry.loc) ? 'ok' : 'blocked'
}

/**
 * What to do with a cached result at `moment` (spec §3.35): use it, use it and refresh in the background
 * (tool calls only), or check now.
 */
export function plan(
  entry: EgressEntry | null,
  allow: readonly string[],
  moment: CheckMoment,
  now: number,
  print: string,
): 'use' | 'refresh' | 'check' {
  if (!entry || entry.netPrint !== print || judge(entry, allow) !== 'ok') return 'check'
  const age = now - Date.parse(entry.checkedAt)
  if (!(age >= 0)) return 'check'
  if (age <= FRESH_MS) return 'use'
  if (moment === 'tool' && age <= STALE_MS) return 'refresh'
  return 'check'
}

/** Asks the network once and keeps the answer (spec §3.35); never throws. */
export async function refresh(opts: {
  url: string
  env: Env
  dir: string
  now?: () => Date
  fetcher?: TraceFetcher
  print?: string
}): Promise<{ entry: EgressEntry; ipChanged: boolean }> {
  const key = cacheKey(opts.url, opts.env)
  const before = await readEntry(opts.dir, key)
  const print = opts.print ?? netPrint()
  let entry: EgressEntry
  let ipChanged = false
  try {
    const t = parseTrace(await (opts.fetcher ?? fetchTrace)(opts.url, opts.env, TIMEOUT_MS))
    const at = (opts.now?.() ?? new Date()).toISOString()
    const ipHash = t.ip ? sha(t.ip) : undefined
    ipChanged = Boolean(ipHash && before?.ipHash && before.ipHash !== ipHash)
    const changedAt = ipChanged ? at : before?.ipChangedAt
    entry = {
      url: opts.url,
      checkedAt: at,
      ...(t.loc ? { loc: t.loc } : { error: 'the answer named no country' }),
      ...(ipHash ? { ipHash } : before?.ipHash ? { ipHash: before.ipHash } : {}),
      ...(changedAt ? { ipChangedAt: changedAt } : {}),
      netPrint: print,
    }
  } catch (err) {
    entry = {
      url: opts.url,
      checkedAt: (opts.now?.() ?? new Date()).toISOString(),
      error: failure(err),
      ...(before?.ipHash ? { ipHash: before.ipHash } : {}),
      ...(before?.ipChangedAt ? { ipChangedAt: before.ipChangedAt } : {}),
      netPrint: print,
    }
  }
  try {
    await mkdir(opts.dir, { recursive: true, mode: 0o700 })
    await writeFileAtomic(entryFile(opts.dir, key), `${JSON.stringify(entry)}\n`, 0o600)
  } catch {
    // an unwritable cache only costs the next call another request
  }
  return { entry, ipChanged }
}

/**
 * The verdict at `moment`: from the cache when it is young enough, else from a request. `background` starts a
 * detached refresh for the tool-call middle tier; without it that tier checks now. Inside a session (`prompt`, `tool`)
 * a request that cannot tell is made again after each of `RETRY_DELAYS_MS` while the tries fit in `RETRY_BUDGET_MS`;
 * a country outside the list blocks at once. Before a Launch one request decides: the user is there to start again.
 */
export async function verdict(opts: {
  url: string
  env: Env
  allow: readonly string[]
  dir: string
  moment: CheckMoment
  now?: () => Date
  fetcher?: TraceFetcher
  print?: string
  background?: () => void
  /** Waits between tries; tests replace it so they do not really wait. */
  sleep?: Sleep
}): Promise<Verdict> {
  const key = cacheKey(opts.url, opts.env)
  const cached = await readEntry(opts.dir, key)
  const print = opts.print ?? netPrint()
  const clock = () => (opts.now?.() ?? new Date()).getTime()
  const now = clock()
  const what = plan(cached, opts.allow, opts.moment, now, print)
  if (cached && (what === 'use' || (what === 'refresh' && opts.background))) {
    if (what === 'refresh') opts.background?.()
    return { status: judge(cached, opts.allow), entry: cached, fresh: false, ipChanged: false }
  }
  let { entry, ipChanged } = await refresh({ ...opts, print })
  let attempts = 1
  if (opts.moment !== 'launch') {
    for (const wait of RETRY_DELAYS_MS) {
      if (judge(entry, opts.allow) !== 'unknown') break
      if (clock() - now + wait + TIMEOUT_MS > RETRY_BUDGET_MS) break
      await (opts.sleep ?? delay)(wait)
      const again = await refresh({ ...opts, print })
      entry = again.entry
      ipChanged ||= again.ipChanged
      attempts++
    }
  }
  return {
    status: judge(entry, opts.allow),
    entry,
    fresh: true,
    ipChanged,
    attempts,
    triedMs: Math.max(0, clock() - now),
  }
}

const NAMES_ZH: Record<string, string> = {
  US: '美国',
  JP: '日本',
  SG: '新加坡',
  HK: '香港',
  TW: '台湾',
  KR: '韩国',
  GB: '英国',
  DE: '德国',
  FR: '法国',
  CA: '加拿大',
  AU: '澳大利亚',
  CN: '中国大陆',
  MO: '澳门',
  NL: '荷兰',
  IN: '印度',
  RU: '俄罗斯',
}

/** "香港（HK）" or "HK": a country for a sentence. */
export function countryLabel(code: string, zh: boolean): string {
  return zh && NAMES_ZH[code] ? `${NAMES_ZH[code]}（${code}）` : code
}

/** Whether messages for a hook or a terminal should be Chinese: the user's locale says so. */
export function prefersChinese(env: Env): boolean {
  return /^zh/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '')
}

/** A failure reason from `refresh` in the user's language (the cache keeps the English one). */
function reasonZh(reason: string): string {
  const m = /^(?:the proxy answered|HTTP) (\d+)$/.exec(reason)
  if (m) return reason.startsWith('HTTP') ? `服务器返回 ${m[1]}` : `代理返回 ${m[1]}`
  const p = /^a (\w+) proxy is not supported$/.exec(reason)
  if (p) return `不支持 ${p[1]} 代理`
  return (
    {
      'no answer within 3 seconds': '3 秒内没有回应',
      'the connection was refused (is the proxy running?)': '连接被拒绝，代理开着吗',
      'the address could not be looked up (offline?)': '域名解析失败，断网了吗',
      'the answer named no country': '回应里没有国家或地区',
      'the proxy address is not a URL': '代理地址写得不对',
      'the request failed': '请求失败',
    }[reason] ?? reason
  )
}

/**
 * What the user reads when Network Guard stops something (spec §3.35): what happened, why, what to do.
 * `at`: `prompt`/`tool` inside a session, `launch` before one.
 */
export function blockMessage(
  v: Pick<Verdict, 'status' | 'entry' | 'attempts' | 'triedMs'>,
  allow: readonly string[],
  opts: { ref?: string; at: CheckMoment; zh: boolean },
): string {
  const ref = opts.ref || '<account>'
  const allowed = allow.map((c) => countryLabel(c, opts.zh)).join(opts.zh ? '、' : ', ')
  const skip = `sideby run ${ref} --ignore-network`
  const reason = v.entry.error ?? 'no answer within 3 seconds'
  const tries = v.attempts ?? 1
  const secs = Math.max(1, Math.round((v.triedMs ?? 0) / 1000))
  if (opts.zh) {
    const tried = tries > 1 ? `试了 ${tries} 次（约 ${secs} 秒）仍` : ''
    const what =
      v.status === 'unknown'
        ? `已拦截：${tried}没能确认网络出口（${reasonZh(reason)}），可能是代理没开或断网。`
        : `已拦截：现在的网络出口在${countryLabel(v.entry.loc ?? '?', true)}，不在允许的地区（${allowed}）里。`
    const next =
      opts.at === 'launch'
        ? '检查代理是否开着、节点是否正确，然后再启动。'
        : opts.at === 'prompt'
          ? '检查代理是否开着、节点是否正确，然后重新发送这条消息。'
          : '检查代理是否开着、节点是否正确，然后让它继续。'
    return `${what}${next}临时跳过：\`${skip}\`。`
  }
  const tried = tries > 1 ? ` after ${tries} tries in about ${secs} s` : ''
  const what =
    v.status === 'unknown'
      ? `Blocked: sideby could not tell this network's exit${tried} (${reason}); the proxy may be off or the network down.`
      : `Blocked: this network exits in ${v.entry.loc}, which is not an allowed country (${allowed}).`
  const next =
    opts.at === 'launch'
      ? 'Check that the proxy is on and the node is right, then start again.'
      : opts.at === 'prompt'
        ? 'Check that the proxy is on and the node is right, then send the message again.'
        : 'Check that the proxy is on and the node is right, then let it continue.'
  return `${what} ${next} To skip once: \`${skip}\`.`
}
